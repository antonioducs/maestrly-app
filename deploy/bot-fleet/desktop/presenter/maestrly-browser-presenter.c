/*
 * maestrly-browser-presenter
 *
 * Runs on a bot's own X display (its desktop, $DISPLAY) and shows a live copy
 * of a rectangle of another X display (--source, the big display where one
 * Electron process draws every bot's browser) inside a normal window-manager
 * decorated window. Every input event the window receives is forwarded to the
 * Electron main process over a Unix socket; nothing is ever injected into the
 * source display. The program is pure mechanism: it holds no routing logic.
 *
 *   maestrly-browser-presenter --source :0 --socket PATH [--verbose]
 *
 * Wire protocol: UTF-8 lines ending in "\n", fields separated by TAB, text
 * payloads in standard base64 with padding, numbers in decimal ASCII, lines of
 * at most 2 MiB. After the handshake (`presenter\t1` answered by `ok` or
 * `err\t<b64>`):
 *
 *   server -> presenter
 *     geometry x y w h   client-area position (root coords) and size
 *     limits minW minH maxW maxH   (a max of 0 means "no maximum")
 *     source x y w h     source-display rectangle mirrored at the window's 0,0
 *     show 0|1           map and raise, without / with activating (0 never
 *                        takes the keyboard from the window that has it)
 *     hide               withdraw the window
 *     title <b64>        window title (UTF-8)
 *     icon w h <b64>     w*h little-endian ARGB32 pixels
 *     setclip <b64>      own CLIPBOARD on the target display with this text
 *     readclip           answer with clip <b64> or clip-none
 *   presenter -> server
 *     key 1|0 keysym state time
 *     button 1|0 n x y state time
 *     motion x y state time
 *     configure x y w h  client area in root coordinates
 *     close | focus 1|0 | visible 1|0 | clip <b64> | clip-none
 *
 * Exit codes: 0 server closed the socket after the handshake, 1 connection or
 * I/O failure, 2 missing X extension or incompatible pixel formats, 3
 * handshake refused, 64 bad command line.
 *
 * Pixels travel through one SysV shared-memory segment attached to both X
 * connections: XShmGetImage fills it from the source display and XShmPutImage
 * reads it for the target window, so no pixel crosses a socket.
 */

#define _DEFAULT_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <X11/XKBlib.h>
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/Xdamage.h>
#include <X11/extensions/Xfixes.h>

#define PROG "maestrly-browser-presenter"

#define EXIT_OK 0
#define EXIT_IO 1
#define EXIT_EXT 2
#define EXIT_REFUSED 3
#define EXIT_USAGE 64

#define CONNECT_ATTEMPTS 50
#define CONNECT_RETRY_MS 100
#define HANDSHAKE_TIMEOUT_MS 10000

#define MAX_LINE (2u * 1024u * 1024u)       /* longest accepted protocol line */
#define IN_INITIAL (64u * 1024u)            /* idle input buffer size */
#define OUT_MAX (8u * 1024u * 1024u)        /* queued bytes before we give up */
#define MAX_FIELDS 8
#define CLIP_MAX (1024u * 1024u)            /* largest clipboard text, bytes */
#define TITLE_MAX 1024u                     /* title bytes kept after decoding */
#define TITLE_B64_MAX (16u * 1024u)
#define ICON_MAX_SIDE 256
#define SRC_MAX_SIDE 8192                   /* source rectangle side limit */
#define SRC_MAX_BYTES (192u * 1024u * 1024u)
#define WIN_MAX_SIDE 16384
#define COORD_MIN (-32768)
#define COORD_MAX 32767

#define FRAME_MS 16                         /* at most ~60 frames per second */
#define CLIP_TIMEOUT_MS 1000
#define SHM_WAIT_MS 1000                    /* patience for MIT-SHM completion events */
#define MAX_PENDING_RECTS 64
#define MAX_READCLIP_WAITERS 16

#define DEFAULT_W 1120
#define DEFAULT_H 640
#define BG_R 0x0d
#define BG_G 0x0d
#define BG_B 0x10

typedef struct {
    int x, y, w, h;
} Rect;

/* ------------------------------------------------------------------------ */
/* Logging                                                                   */
/* ------------------------------------------------------------------------ */

static int verbose;

static void log_msg(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void die(int code, const char *fmt, ...) __attribute__((noreturn, format(printf, 2, 3)));

static void log_msg(const char *fmt, ...)
{
    va_list ap;
    fputs(PROG ": ", stderr);
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
}

static void die(int code, const char *fmt, ...)
{
    va_list ap;
    fputs(PROG ": ", stderr);
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    exit(code);
}

#define DBG(...) \
    do { \
        if (verbose) \
            log_msg(__VA_ARGS__); \
    } while (0)

static long long now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void sleep_ms(int ms)
{
    struct timespec ts = {ms / 1000, (long)(ms % 1000) * 1000000L};
    while (nanosleep(&ts, &ts) < 0 && errno == EINTR) {
    }
}

/* ------------------------------------------------------------------------ */
/* Small helpers: numbers, base64, UTF-8                                      */
/* ------------------------------------------------------------------------ */

/* Strict decimal parse: optional '-', digits only, whole token, within [lo, hi]. */
static int parse_int(const char *s, long lo, long hi, long *out)
{
    const char *p = s;
    char *end;
    long v;

    if (!s)
        return 0;
    if (*p == '-')
        p++;
    if (*p < '0' || *p > '9')
        return 0;
    errno = 0;
    v = strtol(s, &end, 10);
    if (errno != 0 || *end != '\0' || v < lo || v > hi)
        return 0;
    *out = v;
    return 1;
}

static const char B64_ALPHABET[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static size_t b64_encoded_len(size_t n)
{
    return 4 * ((n + 2) / 3);
}

/* `out` must hold b64_encoded_len(n) bytes; no terminator is written. */
static size_t b64_encode(const unsigned char *in, size_t n, char *out)
{
    size_t i = 0, o = 0;
    while (i + 2 < n) {
        uint32_t v = (uint32_t)in[i] << 16 | (uint32_t)in[i + 1] << 8 | in[i + 2];
        out[o++] = B64_ALPHABET[(v >> 18) & 63];
        out[o++] = B64_ALPHABET[(v >> 12) & 63];
        out[o++] = B64_ALPHABET[(v >> 6) & 63];
        out[o++] = B64_ALPHABET[v & 63];
        i += 3;
    }
    if (i < n) {
        uint32_t v = (uint32_t)in[i] << 16;
        if (i + 1 < n)
            v |= (uint32_t)in[i + 1] << 8;
        out[o++] = B64_ALPHABET[(v >> 18) & 63];
        out[o++] = B64_ALPHABET[(v >> 12) & 63];
        out[o++] = (i + 1 < n) ? B64_ALPHABET[(v >> 6) & 63] : '=';
        out[o++] = '=';
    }
    return o;
}

static int b64_value(unsigned char c)
{
    if (c >= 'A' && c <= 'Z')
        return c - 'A';
    if (c >= 'a' && c <= 'z')
        return c - 'a' + 26;
    if (c >= '0' && c <= '9')
        return c - '0' + 52;
    if (c == '+')
        return 62;
    if (c == '/')
        return 63;
    return -1;
}

/*
 * Strict standard base64 (padding required, no whitespace). Returns a malloc'd
 * buffer (never NULL on success, so empty payloads work) or NULL when the input
 * is malformed or would decode to more than `max_out` bytes.
 */
static unsigned char *b64_decode(const char *in, size_t max_out, size_t *out_len)
{
    size_t n = strlen(in), o = 0, i;
    unsigned char *out;

    if (n % 4 != 0 || n / 4 * 3 > max_out + 2)
        return NULL;
    out = malloc(n / 4 * 3 + 1);
    if (!out)
        return NULL;
    for (i = 0; i < n; i += 4) {
        int a = b64_value((unsigned char)in[i]), b = b64_value((unsigned char)in[i + 1]);
        int c, d;
        int last = (i + 4 == n);
        if (a < 0 || b < 0)
            goto bad;
        if (last && in[i + 2] == '=') {
            if (in[i + 3] != '=')
                goto bad;
            out[o++] = (unsigned char)(a << 2 | b >> 4);
            break;
        }
        c = b64_value((unsigned char)in[i + 2]);
        if (c < 0)
            goto bad;
        if (last && in[i + 3] == '=') {
            out[o++] = (unsigned char)(a << 2 | b >> 4);
            out[o++] = (unsigned char)((b & 15) << 4 | c >> 2);
            break;
        }
        d = b64_value((unsigned char)in[i + 3]);
        if (d < 0)
            goto bad;
        out[o++] = (unsigned char)(a << 2 | b >> 4);
        out[o++] = (unsigned char)((b & 15) << 4 | c >> 2);
        out[o++] = (unsigned char)((c & 3) << 6 | d);
    }
    if (o > max_out)
        goto bad;
    *out_len = o;
    return out;
bad:
    free(out);
    return NULL;
}

/* Decodes one UTF-8 sequence; returns its length, or 0 when it is invalid. */
static int utf8_decode(const unsigned char *s, size_t n, uint32_t *cp)
{
    uint32_t c;
    size_t need, i;

    if (n == 0)
        return 0;
    if (s[0] < 0x80) {
        *cp = s[0];
        return 1;
    }
    if (s[0] >= 0xC2 && s[0] <= 0xDF) {
        need = 1;
        c = s[0] & 0x1F;
    } else if (s[0] >= 0xE0 && s[0] <= 0xEF) {
        need = 2;
        c = s[0] & 0x0F;
    } else if (s[0] >= 0xF0 && s[0] <= 0xF4) {
        need = 3;
        c = s[0] & 0x07;
    } else {
        return 0;
    }
    if (n < need + 1)
        return 0;
    for (i = 1; i <= need; i++) {
        if ((s[i] & 0xC0) != 0x80)
            return 0;
        c = c << 6 | (s[i] & 0x3F);
    }
    if ((need == 2 && c < 0x800) || (need == 3 && (c < 0x10000 || c > 0x10FFFF)) ||
        (c >= 0xD800 && c <= 0xDFFF))
        return 0;
    *cp = c;
    return (int)need + 1;
}

/* Copies valid UTF-8, replacing invalid bytes by '?', keeping at most `max` bytes. */
static size_t utf8_sanitize(const unsigned char *in, size_t n, size_t max, unsigned char *out)
{
    size_t i = 0, o = 0;
    while (i < n) {
        uint32_t cp;
        int len = utf8_decode(in + i, n - i, &cp);
        if (len == 0) {
            if (o + 1 > max)
                break;
            out[o++] = '?';
            i++;
            continue;
        }
        if (o + (size_t)len > max)
            break;
        memcpy(out + o, in + i, (size_t)len);
        o += (size_t)len;
        i += (size_t)len;
    }
    return o;
}

/* UTF-8 to Latin-1 (the X STRING target); anything outside Latin-1 becomes '?'. */
static size_t utf8_to_latin1(const unsigned char *in, size_t n, unsigned char *out)
{
    size_t i = 0, o = 0;
    while (i < n) {
        uint32_t cp;
        int len = utf8_decode(in + i, n - i, &cp);
        if (len == 0) {
            out[o++] = '?';
            i++;
            continue;
        }
        out[o++] = cp <= 0xFF ? (unsigned char)cp : '?';
        i += (size_t)len;
    }
    return o;
}

/* `out` must hold 2 * n bytes. */
static size_t latin1_to_utf8(const unsigned char *in, size_t n, unsigned char *out)
{
    size_t i, o = 0;
    for (i = 0; i < n; i++) {
        if (in[i] < 0x80) {
            out[o++] = in[i];
        } else {
            out[o++] = (unsigned char)(0xC0 | in[i] >> 6);
            out[o++] = (unsigned char)(0x80 | (in[i] & 0x3F));
        }
    }
    return o;
}

static Rect rect_intersect(Rect a, Rect b)
{
    int x0 = a.x > b.x ? a.x : b.x;
    int y0 = a.y > b.y ? a.y : b.y;
    int x1 = a.x + a.w < b.x + b.w ? a.x + a.w : b.x + b.w;
    int y1 = a.y + a.h < b.y + b.h ? a.y + a.h : b.y + b.h;
    Rect r = {x0, y0, x1 > x0 ? x1 - x0 : 0, y1 > y0 ? y1 - y0 : 0};
    return r;
}

static Rect rect_union(Rect a, Rect b)
{
    int x0 = a.x < b.x ? a.x : b.x;
    int y0 = a.y < b.y ? a.y : b.y;
    int x1 = a.x + a.w > b.x + b.w ? a.x + a.w : b.x + b.w;
    int y1 = a.y + a.h > b.y + b.h ? a.y + a.h : b.y + b.h;
    Rect r = {x0, y0, x1 - x0, y1 - y0};
    return r;
}

/* ------------------------------------------------------------------------ */
/* Server socket                                                              */
/* ------------------------------------------------------------------------ */

static int sock_fd = -1;
static int handshake_done;

static char *in_buf;
static size_t in_cap, in_len, in_head, in_scan;

static char *out_buf;
static size_t out_cap, out_len, out_off;

/* The peer is gone: orderly after the handshake, otherwise a failure. */
static void server_gone(void)
{
    if (handshake_done) {
        DBG("server closed the connection");
        exit(EXIT_OK);
    }
    die(EXIT_IO, "server closed the connection during the handshake");
}

static int net_connect(const char *path)
{
    struct sockaddr_un sa;
    int attempt, last_errno = 0;

    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof sa.sun_path)
        die(EXIT_IO, "socket path is too long: %s", path);
    memcpy(sa.sun_path, path, strlen(path) + 1);

    for (attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
        int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
        if (fd < 0)
            die(EXIT_IO, "socket: %s", strerror(errno));
        if (connect(fd, (struct sockaddr *)&sa, sizeof sa) == 0)
            return fd;
        last_errno = errno;
        close(fd);
        sleep_ms(CONNECT_RETRY_MS);
    }
    die(EXIT_IO, "cannot connect to %s after %d attempts: %s", path, CONNECT_ATTEMPTS,
        strerror(last_errno));
}

/* Sends the queued bytes; returns when the socket would block or the queue is empty. */
static void net_flush(void)
{
    while (out_off < out_len) {
        ssize_t r = send(sock_fd, out_buf + out_off, out_len - out_off, MSG_NOSIGNAL);
        if (r > 0) {
            out_off += (size_t)r;
            continue;
        }
        if (r < 0 && errno == EINTR)
            continue;
        if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
            return;
        if (r < 0 && (errno == EPIPE || errno == ECONNRESET))
            server_gone();
        die(EXIT_IO, "socket write failed: %s", strerror(errno));
    }
    out_off = out_len = 0;
    if (out_cap > IN_INITIAL) {
        free(out_buf);
        out_buf = NULL;
        out_cap = 0;
    }
}

static int net_out_pending(void)
{
    return out_off < out_len;
}

/* Queues `n` bytes and tries to write them straight away. */
static void net_send(const char *data, size_t n)
{
    if (out_len - out_off + n > OUT_MAX)
        die(EXIT_IO, "output queue overflow: the server does not read the socket");
    if (out_off > 0 && out_len + n > out_cap) {
        memmove(out_buf, out_buf + out_off, out_len - out_off); /* drop what was already sent */
        out_len -= out_off;
        out_off = 0;
    }
    if (out_len + n > out_cap) {
        size_t cap = out_cap ? out_cap : 4096;
        char *grown;
        while (out_len + n > cap)
            cap *= 2;
        grown = realloc(out_buf, cap);
        if (!grown)
            die(EXIT_IO, "out of memory");
        out_buf = grown;
        out_cap = cap;
    }
    memcpy(out_buf + out_len, data, n);
    out_len += n;
    net_flush();
}

static void net_printf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void net_printf(const char *fmt, ...)
{
    char line[512];
    va_list ap;
    int n;

    va_start(ap, fmt);
    n = vsnprintf(line, sizeof line - 1, fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= sizeof line - 1) {
        log_msg("internal error: outgoing line too long");
        return;
    }
    line[n++] = '\n';
    net_send(line, (size_t)n);
}

/* Sends `<prefix><base64 of data>\n`. */
static void net_send_b64(const char *prefix, const unsigned char *data, size_t n)
{
    size_t plen = strlen(prefix);
    size_t total = plen + b64_encoded_len(n) + 1;
    char *line = malloc(total);
    if (!line) {
        log_msg("out of memory while encoding a reply");
        return;
    }
    memcpy(line, prefix, plen);
    b64_encode(data, n, line + plen);
    line[total - 1] = '\n';
    net_send(line, total);
    free(line);
}

/* Reads what is available. Returns 0 on end of stream, 1 otherwise. */
static int net_fill(void)
{
    int rounds;
    for (rounds = 0; rounds < 16; rounds++) {
        ssize_t r;
        if (in_len == in_cap) {
            size_t cap;
            char *grown;
            if (in_head > 0) {
                memmove(in_buf, in_buf + in_head, in_len - in_head);
                in_len -= in_head;
                in_scan = in_scan >= in_head ? in_scan - in_head : 0;
                in_head = 0;
            }
            if (in_len == in_cap) {
                /* Full at the cap: let the caller consume lines (or reject an endless one). */
                if (in_cap >= MAX_LINE + 1)
                    return 1;
                cap = in_cap * 2 > MAX_LINE + 1 ? MAX_LINE + 1 : in_cap * 2;
                grown = realloc(in_buf, cap);
                if (!grown)
                    die(EXIT_IO, "out of memory");
                in_buf = grown;
                in_cap = cap;
            }
        }
        r = recv(sock_fd, in_buf + in_len, in_cap - in_len, 0);
        if (r > 0) {
            in_len += (size_t)r;
            continue;
        }
        if (r == 0)
            return 0;
        if (errno == EINTR)
            continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return 1;
        if (errno == ECONNRESET)
            return 0;
        die(EXIT_IO, "socket read failed: %s", strerror(errno));
    }
    return 1;
}

/* Returns the next complete line (terminator replaced by NUL) or NULL. */
static char *net_next_line(void)
{
    char *nl, *line;
    if (in_head >= in_len)
        return NULL;
    nl = memchr(in_buf + in_scan, '\n', in_len - in_scan);
    if (!nl) {
        in_scan = in_len;
        if (in_len - in_head > MAX_LINE)
            die(EXIT_IO, "protocol line longer than %u bytes", MAX_LINE);
        return NULL;
    }
    line = in_buf + in_head;
    *nl = '\0';
    in_head = (size_t)(nl - in_buf) + 1;
    in_scan = in_head;
    if ((size_t)(nl - line) > MAX_LINE)
        die(EXIT_IO, "protocol line longer than %u bytes", MAX_LINE);
    return line;
}

/* Gives memory back after a big payload (clipboard, icon) has been consumed. */
static void net_trim_input(void)
{
    if (in_head < in_len)
        return;
    in_head = in_len = in_scan = 0;
    if (in_cap > 4 * IN_INITIAL) {
        char *small = realloc(in_buf, IN_INITIAL);
        if (small) {
            in_buf = small;
            in_cap = IN_INITIAL;
        }
    }
}

static int split_fields(char *line, char **fields, int max)
{
    int n = 0;
    char *p = line;
    for (;;) {
        char *tab;
        if (n == max)
            return max + 1;
        fields[n++] = p;
        tab = strchr(p, '\t');
        if (!tab)
            return n;
        *tab = '\0';
        p = tab + 1;
    }
}

/* ------------------------------------------------------------------------ */
/* X state                                                                    */
/* ------------------------------------------------------------------------ */

static Display *dpy;  /* target display: the bot's desktop ($DISPLAY) */
static Display *sdpy; /* source display: where the browsers are drawn */
static int dscr, sscr;
static Window droot, sroot, win;
static GC gc;

static int damage_event_base, damage_error_base;
static int shm_event_base;
static Damage damage;
static XserverRegion damage_region;

static Atom a_wm_protocols, a_wm_delete, a_net_wm_name, a_utf8, a_net_wm_icon, a_net_wm_pid;
static Atom a_net_wm_type, a_net_wm_type_normal, a_net_active_window, a_clipboard, a_targets;
static Atom a_timestamp, a_incr, a_net_wm_user_time, a_sel_prop, a_time_prop;

static unsigned int x_error_count;
static unsigned int x_error_dpy, x_error_src;

/* Requested client area and size limits, applied through WM_NORMAL_HINTS. */
static struct {
    int x, y, w, h;
    int have_pos;
    int have_limits;
    int min_w, min_h, max_w, max_h;
} geo = {0, 0, DEFAULT_W, DEFAULT_H, 0, 0, 0, 0, 0, 0};

static int win_w = DEFAULT_W, win_h = DEFAULT_H; /* last known client size */
static int viewable;                             /* mapped and not iconified */
static int focus_state;
static int last_visible;
static struct {
    int valid, x, y, w, h;
} last_cfg;

/* Mirrored pixels: the shared segment, its two XImages and the dirty state. */
static struct {
    Rect req;      /* rectangle requested by the server (source coords) */
    Rect cl;       /* ... clamped to the source root */
    int ox, oy;    /* where cl starts inside the window */
    int have;      /* a usable segment exists for a non-empty clamped rect */
    int have_frame; /* the segment holds a frame that may be repainted */
    int full_dirty;
    int damage_pending; /* a DamageNotify arrived and was not subtracted yet */
    int put_outstanding; /* XShmPutImage requests not yet completed */
    Rect pend[MAX_PENDING_RECTS];
    int npend;
    long long last_frame;
    long long put_deadline; /* when a missing completion is declared lost */
    int shmid;
    void *addr;
    XImage *dimg, *simg;
    XShmSegmentInfo dinfo, sinfo;
    int d_attached, s_attached;
    int get_failures;
} px;

static unsigned long st_frames, st_rects, st_pixels, st_full;

static int x_error_handler(Display *d, XErrorEvent *e)
{
    char text[128];
    XGetErrorText(d, e->error_code, text, sizeof text);
    log_msg("X error on %s: %s (request %u.%u, resource 0x%lx)", DisplayString(d), text,
            e->request_code, e->minor_code, e->resourceid);
    x_error_count++;
    if (d == dpy)
        x_error_dpy++;
    else if (d == sdpy)
        x_error_src++;
    return 0;
}

static int x_io_error_handler(Display *d)
{
    log_msg("fatal X I/O error on %s: connection lost", d ? DisplayString(d) : "?");
    exit(EXIT_IO);
}

static unsigned long visual_channel(unsigned long mask, unsigned int v)
{
    int shift = 0;
    while (mask && !(mask & 1)) {
        mask >>= 1;
        shift++;
    }
    return ((unsigned long)v * mask / 255) << shift;
}

static unsigned long visual_pixel(const Visual *v, unsigned int r, unsigned int g, unsigned int b)
{
    return visual_channel(v->red_mask, r) | visual_channel(v->green_mask, g) |
           visual_channel(v->blue_mask, b);
}

static void ext_fail(const char *what, Display *d)
{
    die(EXIT_EXT, "required X extension %s is missing on display %s", what, DisplayString(d));
}

/* Largest property payload the target server accepts in one request. */
static size_t max_property_bytes(void)
{
    long units = XExtendedMaxRequestSize(dpy);
    if (units <= 0)
        units = XMaxRequestSize(dpy);
    if (units <= 64)
        return 0;
    return (size_t)(units - 64) * 4;
}

/* ------------------------------------------------------------------------ */
/* Shared memory                                                              */
/* ------------------------------------------------------------------------ */

static Bool is_shm_completion(Display *d, XEvent *ev, XPointer arg)
{
    (void)d;
    (void)arg;
    return ev->type == shm_event_base + ShmCompletion;
}

/* Consumes the completion events that are already queued or readable without blocking. */
static void shm_take_completions(void)
{
    XEvent ev;
    XEventsQueued(dpy, QueuedAfterReading);
    while (px.put_outstanding > 0 && XCheckIfEvent(dpy, &ev, is_shm_completion, NULL))
        px.put_outstanding--;
}

/*
 * Waits (bounded) until the target server finished reading everything we put. A server that
 * never reports completion must not freeze us for good, so after the deadline we assume idle.
 */
static void shm_wait_idle(void)
{
    long long deadline = now_ms() + SHM_WAIT_MS;

    if (px.put_outstanding == 0)
        return;
    XSync(dpy, False); /* the server has handled every put, completions follow in order */
    for (;;) {
        struct pollfd p;
        long long left;
        shm_take_completions();
        if (px.put_outstanding == 0)
            return;
        left = deadline - now_ms();
        if (left <= 0) {
            log_msg("no MIT-SHM completion from %s after %d ms; assuming it is idle",
                    DisplayString(dpy), SHM_WAIT_MS);
            px.put_outstanding = 0;
            return;
        }
        p.fd = ConnectionNumber(dpy);
        p.events = POLLIN;
        p.revents = 0;
        poll(&p, 1, (int)left);
    }
}

static void shm_destroy(void)
{
    if (!px.dimg && !px.simg && !px.addr)
        return;
    shm_wait_idle();
    if (px.d_attached)
        XShmDetach(dpy, &px.dinfo);
    if (px.s_attached)
        XShmDetach(sdpy, &px.sinfo);
    XSync(dpy, False);
    XSync(sdpy, False);
    /* The data belongs to the segment: XDestroyImage must not free() it. */
    if (px.dimg) {
        px.dimg->data = NULL;
        XDestroyImage(px.dimg);
    }
    if (px.simg) {
        px.simg->data = NULL;
        XDestroyImage(px.simg);
    }
    if (px.addr)
        shmdt(px.addr);
    px.dimg = px.simg = NULL;
    px.addr = NULL;
    px.d_attached = px.s_attached = 0;
    px.have = px.have_frame = 0;
}

static int image_formats_match(const XImage *a, const XImage *b)
{
    return a->depth == b->depth && a->bits_per_pixel == b->bits_per_pixel &&
           a->bytes_per_line == b->bytes_per_line && a->byte_order == b->byte_order &&
           a->bitmap_unit == b->bitmap_unit && a->bitmap_bit_order == b->bitmap_bit_order &&
           a->red_mask == b->red_mask && a->green_mask == b->green_mask &&
           a->blue_mask == b->blue_mask;
}

/*
 * One segment, one XImage per connection on the same memory. `format_error` is
 * set when the displays use incompatible pixel formats (exit code 2); any other
 * failure leaves it clear. The segment is marked for removal as soon as both
 * servers attached, so it can never outlive this process.
 */
static int shm_create(int w, int h, int *format_error)
{
    XImage *di, *si;
    size_t size;
    unsigned int before_d, before_s;

    *format_error = 0;
    memset(&px.dinfo, 0, sizeof px.dinfo);
    memset(&px.sinfo, 0, sizeof px.sinfo);
    di = XShmCreateImage(dpy, DefaultVisual(dpy, dscr), (unsigned)DefaultDepth(dpy, dscr), ZPixmap,
                         NULL, &px.dinfo, (unsigned)w, (unsigned)h);
    si = XShmCreateImage(sdpy, DefaultVisual(sdpy, sscr), (unsigned)DefaultDepth(sdpy, sscr),
                         ZPixmap, NULL, &px.sinfo, (unsigned)w, (unsigned)h);
    px.dimg = di;
    px.simg = si;
    if (!di || !si) {
        log_msg("XShmCreateImage failed");
        goto fail;
    }
    if (!image_formats_match(di, si)) {
        log_msg("the displays use different pixel formats (depth %d/%d, bpp %d/%d, masks "
                "%lx,%lx,%lx / %lx,%lx,%lx)",
                di->depth, si->depth, di->bits_per_pixel, si->bits_per_pixel, di->red_mask,
                di->green_mask, di->blue_mask, si->red_mask, si->green_mask, si->blue_mask);
        *format_error = 1;
        goto fail;
    }
    size = (size_t)si->bytes_per_line * (size_t)h;
    if (size == 0 || size > SRC_MAX_BYTES) {
        log_msg("shared image of %dx%d is out of bounds", w, h);
        goto fail;
    }
    px.shmid = shmget(IPC_PRIVATE, size, IPC_CREAT | 0600);
    if (px.shmid < 0) {
        log_msg("shmget(%zu): %s", size, strerror(errno));
        goto fail;
    }
    px.addr = shmat(px.shmid, NULL, 0);
    if (px.addr == (void *)-1) {
        log_msg("shmat: %s", strerror(errno));
        px.addr = NULL;
        shmctl(px.shmid, IPC_RMID, NULL);
        goto fail;
    }
    di->data = px.dinfo.shmaddr = px.addr;
    si->data = px.sinfo.shmaddr = px.addr;
    px.dinfo.shmid = px.sinfo.shmid = px.shmid;
    px.dinfo.readOnly = True; /* the target server only reads */
    px.sinfo.readOnly = False;

    before_d = x_error_dpy;
    before_s = x_error_src;
    px.d_attached = XShmAttach(dpy, &px.dinfo) ? 1 : 0;
    px.s_attached = XShmAttach(sdpy, &px.sinfo) ? 1 : 0;
    XSync(dpy, False);
    XSync(sdpy, False);
    shmctl(px.shmid, IPC_RMID, NULL);
    if (x_error_dpy != before_d)
        px.d_attached = 0;
    if (x_error_src != before_s)
        px.s_attached = 0;
    if (!px.d_attached || !px.s_attached) {
        log_msg("MIT-SHM attach failed on %s (are the X servers in this IPC namespace?)",
                !px.d_attached ? DisplayString(dpy) : DisplayString(sdpy));
        goto fail;
    }
    px.have = 0; /* SysV segments start zero-filled: nothing to clear (and no pages to touch) */
    return 0;
fail:
    shm_destroy();
    return -1;
}

/* ------------------------------------------------------------------------ */
/* Startup checks                                                             */
/* ------------------------------------------------------------------------ */

static void check_extensions_and_formats(void)
{
    int major, minor, dummy;
    Bool pixmaps;
    int format_error;

    if (!XShmQueryExtension(dpy))
        ext_fail("MIT-SHM", dpy);
    if (!XShmQueryExtension(sdpy))
        ext_fail("MIT-SHM", sdpy);
    XShmQueryVersion(dpy, &major, &minor, &pixmaps);
    XShmQueryVersion(sdpy, &major, &minor, &pixmaps);
    shm_event_base = XShmGetEventBase(dpy);

    if (!XDamageQueryExtension(sdpy, &damage_event_base, &damage_error_base))
        ext_fail("DAMAGE", sdpy);
    if (!XDamageQueryVersion(sdpy, &major, &minor) || major < 1)
        ext_fail("DAMAGE (>= 1.0)", sdpy);
    if (!XFixesQueryExtension(sdpy, &dummy, &dummy))
        ext_fail("XFIXES", sdpy);
    if (!XFixesQueryVersion(sdpy, &major, &minor) || major < 2)
        ext_fail("XFIXES (>= 2.0)", sdpy);

    /* Probe with a tiny segment: formats must match and both servers must attach. */
    if (shm_create(16, 16, &format_error) != 0) {
        if (format_error)
            die(EXIT_EXT, "incompatible pixel formats between %s and %s", DisplayString(dpy),
                DisplayString(sdpy));
        die(EXIT_EXT, "MIT-SHM is present but unusable between %s and %s", DisplayString(dpy),
            DisplayString(sdpy));
    }
    shm_destroy();
}

static void intern_atoms(void)
{
    static const char *names[] = {
        "WM_PROTOCOLS",       "WM_DELETE_WINDOW",   "_NET_WM_NAME",    "UTF8_STRING",
        "_NET_WM_ICON",       "_NET_WM_PID",        "_NET_WM_WINDOW_TYPE",
        "_NET_WM_WINDOW_TYPE_NORMAL", "_NET_ACTIVE_WINDOW", "CLIPBOARD", "TARGETS",
        "TIMESTAMP",          "INCR",               "_NET_WM_USER_TIME", "_MAESTRLY_SELECTION",
        "_MAESTRLY_TIME"};
    enum { N = sizeof names / sizeof names[0] };
    Atom atoms[N];
    if (!XInternAtoms(dpy, (char **)names, N, False, atoms))
        die(EXIT_IO, "XInternAtoms failed");
    a_wm_protocols = atoms[0];
    a_wm_delete = atoms[1];
    a_net_wm_name = atoms[2];
    a_utf8 = atoms[3];
    a_net_wm_icon = atoms[4];
    a_net_wm_pid = atoms[5];
    a_net_wm_type = atoms[6];
    a_net_wm_type_normal = atoms[7];
    a_net_active_window = atoms[8];
    a_clipboard = atoms[9];
    a_targets = atoms[10];
    a_timestamp = atoms[11];
    a_incr = atoms[12];
    a_net_wm_user_time = atoms[13];
    a_sel_prop = atoms[14];
    a_time_prop = atoms[15];
}

/* WM_NORMAL_HINTS: static gravity so the WM places the *client area* exactly. */
static void apply_size_hints(void)
{
    XSizeHints h;
    memset(&h, 0, sizeof h);
    h.flags = USSize | PSize | PWinGravity;
    h.width = geo.w;
    h.height = geo.h;
    h.win_gravity = StaticGravity;
    if (geo.have_pos) {
        h.flags |= USPosition | PPosition;
        h.x = geo.x;
        h.y = geo.y;
    }
    if (geo.have_limits) {
        h.flags |= PMinSize | PMaxSize;
        h.min_width = geo.min_w;
        h.min_height = geo.min_h;
        h.max_width = geo.max_w;
        h.max_height = geo.max_h;
    }
    XSetWMNormalHints(dpy, win, &h);
}

static void set_utf8_property(Atom prop, const unsigned char *s, size_t n)
{
    XChangeProperty(dpy, win, prop, a_utf8, 8, PropModeReplace, s, (int)n);
}

static void create_window(void)
{
    XSetWindowAttributes a;
    XClassHint cls;
    XWMHints wmh;
    char res_name[] = "maestrly-browser";
    char res_class[] = "Maestrly-Browser";
    char host[256];
    long pid = (long)getpid();
    Atom type = a_net_wm_type_normal;
    static const unsigned char default_title[] = "Maestrly Browser";

    memset(&a, 0, sizeof a);
    a.background_pixel = visual_pixel(DefaultVisual(dpy, dscr), BG_R, BG_G, BG_B);
    a.bit_gravity = NorthWestGravity; /* keep pixels in place while resizing */
    a.event_mask = KeyPressMask | KeyReleaseMask | ButtonPressMask | ButtonReleaseMask |
                   PointerMotionMask | FocusChangeMask | StructureNotifyMask | ExposureMask |
                   PropertyChangeMask;
    win = XCreateWindow(dpy, droot, 0, 0, (unsigned)geo.w, (unsigned)geo.h, 0,
                        DefaultDepth(dpy, dscr), InputOutput, DefaultVisual(dpy, dscr),
                        CWBackPixel | CWBitGravity | CWEventMask, &a);
    if (!win)
        die(EXIT_IO, "XCreateWindow failed");

    cls.res_name = res_name;
    cls.res_class = res_class;
    XSetClassHint(dpy, win, &cls);
    XSetWMProtocols(dpy, win, &a_wm_delete, 1);
    XChangeProperty(dpy, win, a_net_wm_pid, XA_CARDINAL, 32, PropModeReplace, (unsigned char *)&pid,
                    1);
    XChangeProperty(dpy, win, a_net_wm_type, XA_ATOM, 32, PropModeReplace, (unsigned char *)&type,
                    1);
    memset(&wmh, 0, sizeof wmh);
    wmh.flags = InputHint;
    wmh.input = True;
    XSetWMHints(dpy, win, &wmh);
    if (gethostname(host, sizeof host) == 0) {
        XTextProperty tp;
        char *list[1];
        host[sizeof host - 1] = '\0';
        list[0] = host;
        if (XStringListToTextProperty(list, 1, &tp)) {
            XSetWMClientMachine(dpy, win, &tp);
            XFree(tp.value);
        }
    }
    set_utf8_property(a_net_wm_name, default_title, sizeof default_title - 1);
    set_utf8_property(XA_WM_NAME, default_title, sizeof default_title - 1);
    apply_size_hints();

    gc = XCreateGC(dpy, win, 0, NULL);
    XSetGraphicsExposures(dpy, gc, False);
}

/* ------------------------------------------------------------------------ */
/* Pixels: damage, capture, present                                           */
/* ------------------------------------------------------------------------ */

static void pending_add(Rect r)
{
    if (r.w <= 0 || r.h <= 0)
        return;
    if (px.npend == MAX_PENDING_RECTS) {
        /* Too fragmented: collapse into one bounding box rather than grow. */
        Rect u = px.pend[0];
        int i;
        for (i = 1; i < px.npend; i++)
            u = rect_union(u, px.pend[i]);
        px.pend[0] = u;
        px.npend = 1;
    }
    px.pend[px.npend++] = r;
}

static void put_image_rect(Rect r)
{
    /* send_event=True: the server tells us when it stopped reading the segment. */
    XShmPutImage(dpy, win, gc, px.dimg, r.x, r.y, r.x + px.ox, r.y + px.oy, (unsigned)r.w,
                 (unsigned)r.h, True);
    if (px.put_outstanding++ == 0)
        px.put_deadline = now_ms() + SHM_WAIT_MS;
}

/* Paints the area around the mirrored image with the window background. */
static void clear_outside_image(void)
{
    int iw = px.have ? px.cl.w : 0, ih = px.have ? px.cl.h : 0;
    int x0 = px.have ? px.ox : 0, y0 = px.have ? px.oy : 0;
    int x1 = x0 + iw, y1 = y0 + ih;

    if (!px.have) {
        XClearArea(dpy, win, 0, 0, 0, 0, False);
        return;
    }
    if (y0 > 0)
        XClearArea(dpy, win, 0, 0, (unsigned)win_w, (unsigned)y0, False);
    if (y1 < win_h)
        XClearArea(dpy, win, 0, y1, (unsigned)win_w, (unsigned)(win_h - y1), False);
    if (x0 > 0)
        XClearArea(dpy, win, 0, y0, (unsigned)x0, (unsigned)ih, False);
    if (x1 < win_w)
        XClearArea(dpy, win, x1, y0, (unsigned)(win_w - x1), (unsigned)ih, False);
}

static void apply_source(int x, int y, int w, int h)
{
    Rect req = {x, y, w, h};
    Rect bounds = {0, 0, DisplayWidth(sdpy, sscr), DisplayHeight(sdpy, sscr)};
    Rect cl = rect_intersect(req, bounds);

    if (px.req.x == x && px.req.y == y && px.req.w == w && px.req.h == h && (px.have || cl.w == 0))
        return;
    px.req = req;
    if (cl.w <= 0 || cl.h <= 0) {
        shm_destroy();
        px.npend = 0;
        px.full_dirty = 0;
        if (viewable)
            clear_outside_image();
        DBG("source %d,%d %dx%d lies outside the source display; mirroring nothing", x, y, w, h);
        return;
    }
    if (!px.have || cl.w != px.cl.w || cl.h != px.cl.h) {
        int format_error;
        shm_destroy();
        if (shm_create(cl.w, cl.h, &format_error) != 0)
            die(format_error ? EXIT_EXT : EXIT_IO, "cannot create the shared image for %dx%d",
                cl.w, cl.h);
        DBG("shared image %dx%d (%zu bytes)", cl.w, cl.h,
            (size_t)px.simg->bytes_per_line * (size_t)cl.h);
    }
    px.cl = cl;
    px.ox = cl.x - x;
    px.oy = cl.y - y;
    px.have = 1;
    px.have_frame = 0;
    px.full_dirty = 1;
    px.npend = 0;
    if (viewable)
        clear_outside_image();
}

static void damage_collect(void)
{
    if (px.full_dirty) {
        XDamageSubtract(sdpy, damage, None, None);
        px.npend = 0;
        return;
    }
    XDamageSubtract(sdpy, damage, None, damage_region);
    {
        int n = 0, i;
        XRectangle *rects = XFixesFetchRegion(sdpy, damage_region, &n);
        for (i = 0; rects && i < n; i++) {
            Rect r = {rects[i].x, rects[i].y, rects[i].width, rects[i].height};
            r = rect_intersect(r, px.cl);
            r.x -= px.cl.x;
            r.y -= px.cl.y;
            pending_add(r);
        }
        if (rects)
            XFree(rects);
    }
}

/* One capture + present cycle; at most every FRAME_MS and never while the server still reads. */
static void maybe_frame(long long now)
{
    int i, full;
    unsigned long pixels = 0;
    char desc[256];
    size_t dl = 0;

    if (!px.have || !viewable || px.put_outstanding > 0)
        return;
    if (!px.damage_pending && !px.full_dirty)
        return;
    if (now - px.last_frame < FRAME_MS)
        return;
    px.last_frame = now;

    if (px.damage_pending) {
        px.damage_pending = 0;
        damage_collect();
    }
    if (!px.full_dirty && px.npend == 0)
        return; /* the damage was outside our rectangle */

    if (!XShmGetImage(sdpy, sroot, px.simg, px.cl.x, px.cl.y, AllPlanes)) {
        if (++px.get_failures >= 50)
            die(EXIT_IO, "XShmGetImage keeps failing on %s", DisplayString(sdpy));
        px.full_dirty = 1;
        return;
    }
    px.get_failures = 0;
    px.have_frame = 1;
    full = px.full_dirty;
    desc[0] = '\0';
    if (full) {
        Rect all = {0, 0, px.cl.w, px.cl.h};
        put_image_rect(all);
        pixels = (unsigned long)all.w * (unsigned long)all.h;
        st_full++;
        st_rects++;
    } else {
        for (i = 0; i < px.npend; i++) {
            put_image_rect(px.pend[i]);
            pixels += (unsigned long)px.pend[i].w * (unsigned long)px.pend[i].h;
            if (verbose && dl + 40 < sizeof desc)
                dl += (size_t)snprintf(desc + dl, sizeof desc - dl, " %d,%d+%dx%d", px.pend[i].x,
                                       px.pend[i].y, px.pend[i].w, px.pend[i].h);
            st_rects++;
        }
    }
    st_frames++;
    st_pixels += pixels;
    if (verbose) {
        static long long prev_logged;
        log_msg("frame %lu (+%lld ms): get %dx%d, put %s %d rect(s), %lu px:%s", st_frames,
                prev_logged ? now - prev_logged : 0, px.cl.w, px.cl.h, full ? "FULL" : "damage",
                full ? 1 : px.npend, pixels, full ? " all" : desc);
        prev_logged = now;
    }
    px.full_dirty = 0;
    px.npend = 0;
    XFlush(dpy);
}

static void repaint_exposed(Rect expose)
{
    Rect image = {px.ox, px.oy, px.cl.w, px.cl.h};
    Rect r;
    if (!px.have || !px.have_frame)
        return;
    r = rect_intersect(expose, image);
    if (r.w <= 0 || r.h <= 0)
        return;
    r.x -= px.ox;
    r.y -= px.oy;
    put_image_rect(r);
    DBG("expose repaint %d,%d+%dx%d", r.x, r.y, r.w, r.h);
}

/* ------------------------------------------------------------------------ */
/* Clipboard                                                                  */
/* ------------------------------------------------------------------------ */

static unsigned char *clip_text; /* text we own the CLIPBOARD for, or NULL */
static size_t clip_len;
static Time clip_time;

static int conv_pending;
static Atom conv_target;
static long long conv_deadline;
static int conv_waiters;

static Bool is_time_property(Display *d, XEvent *ev, XPointer arg)
{
    (void)d;
    (void)arg;
    return ev->type == PropertyNotify && ev->xproperty.window == win &&
           ev->xproperty.atom == a_time_prop && ev->xproperty.state == PropertyNewValue;
}

/* A real server timestamp, obtained with the zero-length property append trick. */
static Time server_time(void)
{
    XEvent ev;
    XChangeProperty(dpy, win, a_time_prop, XA_STRING, 8, PropModeAppend, NULL, 0);
    XIfEvent(dpy, &ev, is_time_property, NULL);
    return ev.xproperty.time;
}

static void clip_drop(void)
{
    free(clip_text);
    clip_text = NULL;
    clip_len = 0;
}

static void cmd_setclip(const char *b64)
{
    size_t n;
    unsigned char *text = b64_decode(b64, CLIP_MAX, &n);
    Time t;

    if (!text) {
        log_msg("setclip: invalid or oversized payload ignored");
        return;
    }
    t = server_time();
    XSetSelectionOwner(dpy, a_clipboard, win, t);
    if (XGetSelectionOwner(dpy, a_clipboard) != win) {
        log_msg("setclip: could not become CLIPBOARD owner");
        free(text);
        return;
    }
    clip_drop();
    clip_text = text;
    clip_len = n;
    clip_time = t;
    DBG("owning CLIPBOARD with %zu bytes", n);
}

static void on_selection_request(const XSelectionRequestEvent *rq)
{
    XEvent reply;
    Atom prop = rq->property != None ? rq->property : rq->target;
    int ok = 0;
    size_t limit = max_property_bytes();

    memset(&reply, 0, sizeof reply);
    reply.xselection.type = SelectionNotify;
    reply.xselection.requestor = rq->requestor;
    reply.xselection.selection = rq->selection;
    reply.xselection.target = rq->target;
    reply.xselection.property = None;
    reply.xselection.time = rq->time;

    if (clip_text && rq->selection == a_clipboard &&
        (rq->time == CurrentTime || rq->time >= clip_time)) {
        if (rq->target == a_targets) {
            Atom targets[4] = {a_targets, a_utf8, XA_STRING, a_timestamp};
            XChangeProperty(dpy, rq->requestor, prop, XA_ATOM, 32, PropModeReplace,
                            (unsigned char *)targets, 4);
            ok = 1;
        } else if (rq->target == a_timestamp) {
            long ts = (long)clip_time;
            XChangeProperty(dpy, rq->requestor, prop, XA_INTEGER, 32, PropModeReplace,
                            (unsigned char *)&ts, 1);
            ok = 1;
        } else if (rq->target == a_utf8 && clip_len <= limit) {
            XChangeProperty(dpy, rq->requestor, prop, a_utf8, 8, PropModeReplace, clip_text,
                            (int)clip_len);
            ok = 1;
        } else if (rq->target == XA_STRING && clip_len <= limit) {
            unsigned char *latin = malloc(clip_len ? clip_len : 1);
            if (latin) {
                size_t n = utf8_to_latin1(clip_text, clip_len, latin);
                XChangeProperty(dpy, rq->requestor, prop, XA_STRING, 8, PropModeReplace, latin,
                                (int)n);
                free(latin);
                ok = 1;
            }
        }
    }
    if (ok)
        reply.xselection.property = prop;
    else
        DBG("refused selection request for target %lu", rq->target);
    XSendEvent(dpy, rq->requestor, False, NoEventMask, &reply);
}

static void conv_finish(const unsigned char *utf8, size_t n)
{
    int i, waiters = conv_waiters;
    conv_pending = 0;
    conv_waiters = 0;
    for (i = 0; i < waiters; i++) {
        if (utf8)
            net_send_b64("clip\t", utf8, n);
        else
            net_printf("clip-none");
    }
}

static void conv_start(Atom target)
{
    XDeleteProperty(dpy, win, a_sel_prop);
    XConvertSelection(dpy, a_clipboard, target, a_sel_prop, win, CurrentTime);
    conv_target = target;
}

static void cmd_readclip(void)
{
    if (clip_text) {
        net_send_b64("clip\t", clip_text, clip_len); /* we own it: no round trip needed */
        return;
    }
    if (conv_pending) {
        if (conv_waiters < MAX_READCLIP_WAITERS)
            conv_waiters++;
        else
            net_printf("clip-none");
        return;
    }
    if (XGetSelectionOwner(dpy, a_clipboard) == None) {
        net_printf("clip-none");
        return;
    }
    conv_pending = 1;
    conv_waiters = 1;
    conv_deadline = now_ms() + CLIP_TIMEOUT_MS;
    conv_start(a_utf8);
}

static void on_selection_notify(const XSelectionEvent *ev)
{
    Atom type = None;
    int format = 0;
    unsigned long nitems = 0, after = 0;
    unsigned char *data = NULL;

    if (!conv_pending || ev->selection != a_clipboard || ev->target != conv_target)
        return; /* a late answer to a request that already timed out */
    if (ev->property == None) {
        if (conv_target == a_utf8) {
            conv_start(XA_STRING); /* the owner has no UTF-8: fall back to Latin-1 */
            return;
        }
        conv_finish(NULL, 0);
        return;
    }
    if (XGetWindowProperty(dpy, win, ev->property, 0, (long)(CLIP_MAX / 4 + 1), False,
                           AnyPropertyType, &type, &format, &nitems, &after,
                           &data) != Success) {
        conv_finish(NULL, 0);
        return;
    }
    XDeleteProperty(dpy, win, ev->property);
    if (type == a_incr || format != 8 || after > 0 || nitems > CLIP_MAX ||
        (type != a_utf8 && type != XA_STRING)) {
        DBG("clipboard owner replied with type %lu, %lu items, %lu bytes left: giving up", type,
            nitems, after);
        conv_finish(NULL, 0);
    } else if (type == XA_STRING) {
        unsigned char *utf8 = malloc(nitems * 2 + 1);
        if (utf8) {
            size_t n = latin1_to_utf8(data, nitems, utf8);
            conv_finish(utf8, n);
            free(utf8);
        } else {
            conv_finish(NULL, 0);
        }
    } else {
        conv_finish(data ? data : (const unsigned char *)"", nitems);
    }
    if (data)
        XFree(data);
}

static void check_conv_timeout(long long now)
{
    if (conv_pending && now >= conv_deadline) {
        DBG("clipboard conversion timed out");
        XDeleteProperty(dpy, win, a_sel_prop);
        conv_finish(NULL, 0);
    }
}

/* ------------------------------------------------------------------------ */
/* Window commands                                                            */
/* ------------------------------------------------------------------------ */

static void send_activate_request(void)
{
    XEvent ev;
    memset(&ev, 0, sizeof ev);
    ev.xclient.type = ClientMessage;
    ev.xclient.window = win;
    ev.xclient.message_type = a_net_active_window;
    ev.xclient.format = 32;
    ev.xclient.data.l[0] = 2; /* source: pager, so the WM skips focus stealing prevention */
    ev.xclient.data.l[1] = CurrentTime;
    ev.xclient.data.l[2] = 0;
    XSendEvent(dpy, droot, False, SubstructureRedirectMask | SubstructureNotifyMask, &ev);
}

static void cmd_show(int activate)
{
    if (!viewable) {
        if (activate) {
            XDeleteProperty(dpy, win, a_net_wm_user_time);
            XMapRaised(dpy, win);
        } else {
            unsigned long zero = 0; /* user time 0: the WM must not focus it on map */
            XChangeProperty(dpy, win, a_net_wm_user_time, XA_CARDINAL, 32, PropModeReplace,
                            (unsigned char *)&zero, 1);
            XMapWindow(dpy, win);
            /* The WM maps an unfocused window below the focused one; the raise request follows the map request. */
            XRaiseWindow(dpy, win);
        }
    } else {
        XRaiseWindow(dpy, win);
    }
    if (activate)
        send_activate_request();
}

static void cmd_geometry(int x, int y, int w, int h)
{
    geo.x = x;
    geo.y = y;
    geo.w = w;
    geo.h = h;
    geo.have_pos = 1;
    apply_size_hints();
    XMoveResizeWindow(dpy, win, x, y, (unsigned)w, (unsigned)h);
}

static void cmd_limits(int min_w, int min_h, int max_w, int max_h)
{
    geo.have_limits = 1;
    geo.min_w = min_w;
    geo.min_h = min_h;
    geo.max_w = max_w ? max_w : COORD_MAX;
    geo.max_h = max_h ? max_h : COORD_MAX;
    apply_size_hints();
}

static void cmd_title(const char *b64)
{
    size_t n, k;
    unsigned char *raw = b64_decode(b64, TITLE_B64_MAX, &n), *clean;
    if (!raw) {
        log_msg("title: invalid payload ignored");
        return;
    }
    clean = malloc(n + 1);
    if (!clean) {
        free(raw);
        return;
    }
    k = utf8_sanitize(raw, n, TITLE_MAX, clean);
    set_utf8_property(a_net_wm_name, clean, k);
    set_utf8_property(XA_WM_NAME, clean, k);
    free(clean);
    free(raw);
}

static void cmd_icon(int w, int h, const char *b64)
{
    size_t n, count = (size_t)w * (size_t)h, i;
    unsigned char *raw = b64_decode(b64, count * 4, &n);
    long *items;

    if (!raw || n != count * 4) {
        log_msg("icon: payload is not %dx%d ARGB32 pixels; ignored", w, h);
        free(raw);
        return;
    }
    if ((count + 2) * 4 > max_property_bytes()) {
        log_msg("icon: too large for one X request; ignored");
        free(raw);
        return;
    }
    items = malloc((count + 2) * sizeof *items);
    if (!items) {
        free(raw);
        return;
    }
    items[0] = w;
    items[1] = h;
    for (i = 0; i < count; i++) {
        const unsigned char *p = raw + i * 4;
        uint32_t v = (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 |
                     (uint32_t)p[3] << 24;
        items[2 + i] = (long)v; /* Xlib takes `long` items for format 32 */
    }
    XChangeProperty(dpy, win, a_net_wm_icon, XA_CARDINAL, 32, PropModeReplace,
                    (unsigned char *)items, (int)(count + 2));
    free(items);
    free(raw);
}

/* ------------------------------------------------------------------------ */
/* Server command dispatch                                                    */
/* ------------------------------------------------------------------------ */

static void bad_command(const char *name, const char *why)
{
    log_msg("ignoring %.32s: %s", name, why);
}

static void handle_line(char *line)
{
    char *f[MAX_FIELDS + 1];
    int nf = split_fields(line, f, MAX_FIELDS + 1);
    const char *cmd = f[0];
    long v[4];

    if (cmd[0] == '\0')
        return;
    if (nf > MAX_FIELDS) {
        bad_command(cmd, "too many fields");
        return;
    }
    if (strcmp(cmd, "geometry") == 0) {
        if (nf == 5 && parse_int(f[1], COORD_MIN, COORD_MAX, &v[0]) &&
            parse_int(f[2], COORD_MIN, COORD_MAX, &v[1]) &&
            parse_int(f[3], 1, WIN_MAX_SIDE, &v[2]) && parse_int(f[4], 1, WIN_MAX_SIDE, &v[3]))
            cmd_geometry((int)v[0], (int)v[1], (int)v[2], (int)v[3]);
        else
            bad_command(cmd, "expected x y w h in range");
    } else if (strcmp(cmd, "limits") == 0) {
        if (nf == 5 && parse_int(f[1], 1, COORD_MAX, &v[0]) && parse_int(f[2], 1, COORD_MAX, &v[1]) &&
            parse_int(f[3], 0, COORD_MAX, &v[2]) && parse_int(f[4], 0, COORD_MAX, &v[3]) &&
            (v[2] == 0 || v[2] >= v[0]) && (v[3] == 0 || v[3] >= v[1]))
            cmd_limits((int)v[0], (int)v[1], (int)v[2], (int)v[3]);
        else
            bad_command(cmd, "expected minW minH maxW maxH in range");
    } else if (strcmp(cmd, "source") == 0) {
        if (nf == 5 && parse_int(f[1], COORD_MIN, COORD_MAX, &v[0]) &&
            parse_int(f[2], COORD_MIN, COORD_MAX, &v[1]) &&
            parse_int(f[3], 0, SRC_MAX_SIDE, &v[2]) && parse_int(f[4], 0, SRC_MAX_SIDE, &v[3]))
            apply_source((int)v[0], (int)v[1], (int)v[2], (int)v[3]);
        else
            bad_command(cmd, "expected x y w h in range");
    } else if (strcmp(cmd, "show") == 0) {
        if (nf == 2 && parse_int(f[1], 0, 1, &v[0]))
            cmd_show((int)v[0]);
        else
            bad_command(cmd, "expected 0 or 1");
    } else if (strcmp(cmd, "hide") == 0) {
        if (nf == 1)
            XWithdrawWindow(dpy, win, dscr);
        else
            bad_command(cmd, "takes no arguments");
    } else if (strcmp(cmd, "title") == 0) {
        if (nf == 2)
            cmd_title(f[1]);
        else
            bad_command(cmd, "expected one base64 field");
    } else if (strcmp(cmd, "icon") == 0) {
        if (nf == 4 && parse_int(f[1], 1, ICON_MAX_SIDE, &v[0]) &&
            parse_int(f[2], 1, ICON_MAX_SIDE, &v[1]))
            cmd_icon((int)v[0], (int)v[1], f[3]);
        else
            bad_command(cmd, "expected w h base64");
    } else if (strcmp(cmd, "setclip") == 0) {
        if (nf == 2)
            cmd_setclip(f[1]);
        else
            bad_command(cmd, "expected one base64 field");
    } else if (strcmp(cmd, "readclip") == 0) {
        if (nf == 1)
            cmd_readclip();
        else
            bad_command(cmd, "takes no arguments");
    } else {
        bad_command(cmd, "unknown command");
    }
}

static void process_lines(void)
{
    char *line;
    while ((line = net_next_line()) != NULL)
        handle_line(line);
    net_trim_input();
}

/* ------------------------------------------------------------------------ */
/* X events                                                                   */
/* ------------------------------------------------------------------------ */

static void set_viewable(int v)
{
    if (v == viewable)
        return;
    viewable = v;
    if (v) {
        px.full_dirty = 1; /* we skipped frames while hidden */
    } else if (focus_state) {
        focus_state = 0;
        net_printf("focus\t0");
    }
    if (v != last_visible) {
        last_visible = v;
        net_printf("visible\t%d", v);
    }
}

static void report_configure(int w, int h)
{
    int rx, ry;
    Window child;
    if (!XTranslateCoordinates(dpy, win, droot, 0, 0, &rx, &ry, &child))
        return;
    if (last_cfg.valid && last_cfg.x == rx && last_cfg.y == ry && last_cfg.w == w &&
        last_cfg.h == h)
        return;
    last_cfg.valid = 1;
    last_cfg.x = rx;
    last_cfg.y = ry;
    last_cfg.w = w;
    last_cfg.h = h;
    net_printf("configure\t%d\t%d\t%d\t%d", rx, ry, w, h);
}

static void handle_key(const XKeyEvent *k, int press)
{
    char buf[16];
    KeySym sym = NoSymbol;
    XLookupString((XKeyEvent *)k, buf, (int)sizeof buf, &sym, NULL);
    if (sym == NoSymbol) {
        DBG("key event with keycode %u has no keysym; dropped", k->keycode);
        return;
    }
    net_printf("key\t%d\t%lu\t%u\t%lu", press, (unsigned long)sym, k->state, (unsigned long)k->time);
}

static void handle_focus(const XFocusChangeEvent *f, int in)
{
    if (f->mode != NotifyNormal)
        return;
    if (f->detail == NotifyPointer || f->detail == NotifyPointerRoot || f->detail == NotifyDetailNone ||
        f->detail == NotifyInferior)
        return;
    if (focus_state == in)
        return;
    focus_state = in;
    net_printf("focus\t%d", in);
}

static void handle_target_event(XEvent *ev)
{
    switch (ev->type) {
    case KeyPress:
        handle_key(&ev->xkey, 1);
        break;
    case KeyRelease:
        handle_key(&ev->xkey, 0);
        break;
    case ButtonPress:
    case ButtonRelease:
        net_printf("button\t%d\t%u\t%d\t%d\t%u\t%lu", ev->type == ButtonPress, ev->xbutton.button,
                   ev->xbutton.x, ev->xbutton.y, ev->xbutton.state, (unsigned long)ev->xbutton.time);
        break;
    case MotionNotify:
        /* Compress a burst: only the newest queued motion is worth forwarding. */
        while (XEventsQueued(dpy, QueuedAlready) > 0) {
            XEvent next;
            XPeekEvent(dpy, &next);
            if (next.type != MotionNotify)
                break;
            XNextEvent(dpy, ev);
        }
        net_printf("motion\t%d\t%d\t%u\t%lu", ev->xmotion.x, ev->xmotion.y, ev->xmotion.state,
                   (unsigned long)ev->xmotion.time);
        break;
    case FocusIn:
        handle_focus(&ev->xfocus, 1);
        break;
    case FocusOut:
        handle_focus(&ev->xfocus, 0);
        break;
    case ConfigureNotify: {
        XEvent next;
        int w, h;
        while (XCheckTypedWindowEvent(dpy, win, ConfigureNotify, &next))
            *ev = next;
        w = ev->xconfigure.width;
        h = ev->xconfigure.height;
        win_w = w;
        win_h = h;
        report_configure(w, h);
        break;
    }
    case MapNotify:
        if (ev->xmap.window == win)
            set_viewable(1);
        break;
    case UnmapNotify:
        if (ev->xunmap.window == win)
            set_viewable(0);
        break;
    case Expose: {
        /* Merge the whole burst, then repaint the bounding box from the segment. */
        static Rect box;
        static int have_box;
        Rect r = {ev->xexpose.x, ev->xexpose.y, ev->xexpose.width, ev->xexpose.height};
        box = have_box ? rect_union(box, r) : r;
        have_box = 1;
        if (ev->xexpose.count == 0) {
            have_box = 0;
            repaint_exposed(box);
        }
        break;
    }
    case ClientMessage:
        if (ev->xclient.message_type == a_wm_protocols && ev->xclient.format == 32 &&
            (Atom)ev->xclient.data.l[0] == a_wm_delete)
            net_printf("close");
        break;
    case MappingNotify:
        if (ev->xmapping.request != MappingPointer)
            XRefreshKeyboardMapping(&ev->xmapping);
        break;
    case SelectionRequest:
        on_selection_request(&ev->xselectionrequest);
        break;
    case SelectionClear:
        if (ev->xselectionclear.selection == a_clipboard) {
            DBG("lost CLIPBOARD ownership");
            clip_drop();
        }
        break;
    case SelectionNotify:
        on_selection_notify(&ev->xselection);
        break;
    default:
        if (ev->type == shm_event_base + ShmCompletion) {
            if (px.put_outstanding > 0)
                px.put_outstanding--;
        }
        break;
    }
}

static void handle_source_event(const XEvent *ev)
{
    if (ev->type == damage_event_base + XDamageNotify)
        px.damage_pending = 1;
}

static void drain_events(void)
{
    for (;;) {
        int handled = 0;
        while (XPending(dpy)) {
            XEvent ev;
            XNextEvent(dpy, &ev);
            handle_target_event(&ev);
            handled++;
        }
        while (XPending(sdpy)) {
            XEvent ev;
            XNextEvent(sdpy, &ev);
            handle_source_event(&ev);
            handled++;
        }
        if (!handled)
            return;
    }
}

/* ------------------------------------------------------------------------ */
/* Main loop                                                                  */
/* ------------------------------------------------------------------------ */

static void handshake(void)
{
    long long deadline = now_ms() + HANDSHAKE_TIMEOUT_MS;
    static const char hello[] = "presenter\t1\n";
    char *line, *f[3];
    int nf, eof = 0;

    net_send(hello, sizeof hello - 1);
    for (;;) {
        struct pollfd p;
        long long left = deadline - now_ms();
        int r;
        if (net_out_pending())
            net_flush();
        if ((line = net_next_line()) != NULL)
            break;
        /* A refusal may arrive together with the close: read the reply before giving up. */
        if (eof)
            die(EXIT_IO, "server closed the connection during the handshake");
        if (left <= 0)
            die(EXIT_IO, "timed out waiting for the handshake reply");
        p.fd = sock_fd;
        p.events = POLLIN | (net_out_pending() ? POLLOUT : 0);
        p.revents = 0;
        r = poll(&p, 1, (int)left);
        if (r < 0 && errno != EINTR)
            die(EXIT_IO, "poll: %s", strerror(errno));
        if (r > 0 && (p.revents & (POLLIN | POLLHUP | POLLERR)) && !net_fill())
            eof = 1;
    }
    nf = split_fields(line, f, 3);
    if (nf == 1 && strcmp(f[0], "ok") == 0) {
        handshake_done = 1;
        return;
    }
    if (nf == 2 && strcmp(f[0], "err") == 0) {
        size_t n;
        unsigned char *msg = b64_decode(f[1], 4096, &n);
        if (msg) {
            unsigned char *clean = malloc(n + 1);
            if (clean) {
                size_t k = utf8_sanitize(msg, n, 4096, clean);
                clean[k] = '\0';
                fprintf(stderr, PROG ": handshake refused: %s\n", clean);
                free(clean);
            }
            free(msg);
        } else {
            log_msg("handshake refused");
        }
        exit(EXIT_REFUSED);
    }
    die(EXIT_IO, "unexpected handshake reply");
}

/* A completion that never arrives (e.g. the put itself failed) must not stall the mirror. */
static void check_put_watchdog(long long now)
{
    if (px.put_outstanding > 0 && now >= px.put_deadline) {
        XSync(dpy, False);
        shm_take_completions();
        if (px.put_outstanding > 0) {
            log_msg("no MIT-SHM completion from %s after %d ms; assuming it is idle",
                    DisplayString(dpy), SHM_WAIT_MS);
            px.put_outstanding = 0;
        }
    }
}

static int compute_timeout(long long now)
{
    long long t = -1;
    if (px.have && viewable && (px.damage_pending || px.full_dirty) && px.put_outstanding == 0) {
        long long due = px.last_frame + FRAME_MS - now;
        t = due > 0 ? due : 0;
    }
    if (conv_pending) {
        long long due = conv_deadline - now;
        if (due < 0)
            due = 0;
        if (t < 0 || due < t)
            t = due;
    }
    if (px.put_outstanding > 0) {
        long long due = px.put_deadline - now;
        if (due < 0)
            due = 0;
        if (t < 0 || due < t)
            t = due;
    }
    if (XEventsQueued(dpy, QueuedAlready) > 0 || XEventsQueued(sdpy, QueuedAlready) > 0)
        t = 0;
    return t < 0 ? -1 : (int)t;
}

static void run(void)
{
    for (;;) {
        struct pollfd p[3];
        long long now;
        int r;

        drain_events();
        now = now_ms();
        check_put_watchdog(now);
        maybe_frame(now);
        check_conv_timeout(now);
        XFlush(dpy);
        XFlush(sdpy);

        p[0].fd = ConnectionNumber(dpy);
        p[0].events = POLLIN;
        p[1].fd = ConnectionNumber(sdpy);
        p[1].events = POLLIN;
        p[2].fd = sock_fd;
        p[2].events = POLLIN | (net_out_pending() ? POLLOUT : 0);
        p[0].revents = p[1].revents = p[2].revents = 0;

        r = poll(p, 3, compute_timeout(now_ms()));
        if (r < 0) {
            if (errno == EINTR)
                continue;
            die(EXIT_IO, "poll: %s", strerror(errno));
        }
        if (p[0].revents & (POLLERR | POLLNVAL))
            die(EXIT_IO, "connection to %s failed", DisplayString(dpy));
        if (p[1].revents & (POLLERR | POLLNVAL))
            die(EXIT_IO, "connection to %s failed", DisplayString(sdpy));
        if ((p[0].revents & POLLHUP) && !(p[0].revents & POLLIN))
            die(EXIT_IO, "connection to %s closed", DisplayString(dpy));
        if ((p[1].revents & POLLHUP) && !(p[1].revents & POLLIN))
            die(EXIT_IO, "connection to %s closed", DisplayString(sdpy));

        if (p[2].revents & POLLOUT)
            net_flush();
        if (p[2].revents & (POLLIN | POLLHUP | POLLERR)) {
            int alive = net_fill();
            process_lines(); /* lines that arrived with the close still count */
            if (!alive)
                server_gone();
        }
    }
}

static void usage(FILE *out)
{
    fprintf(out, "usage: " PROG " --source DISPLAY --socket PATH [--verbose]\n"
                 "  Mirrors a rectangle of --source into a window on $DISPLAY and forwards\n"
                 "  the window's input to the server listening on the Unix socket PATH.\n");
}

int main(int argc, char **argv)
{
    const char *source_name = NULL, *socket_path = NULL, *target_name;
    int i;

    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--source") == 0 && i + 1 < argc)
            source_name = argv[++i];
        else if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc)
            socket_path = argv[++i];
        else if (strcmp(argv[i], "--verbose") == 0 || strcmp(argv[i], "-v") == 0)
            verbose = 1;
        else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            usage(stdout);
            return EXIT_OK;
        } else {
            usage(stderr);
            return EXIT_USAGE;
        }
    }
    if (!source_name || !socket_path) {
        usage(stderr);
        return EXIT_USAGE;
    }
    target_name = getenv("DISPLAY");
    if (!target_name || !*target_name)
        die(EXIT_IO, "DISPLAY is not set: no target display to present on");
    if (strcmp(target_name, source_name) == 0)
        die(EXIT_IO, "the source and the target display are both %s", source_name);

    signal(SIGPIPE, SIG_IGN);
    XSetErrorHandler(x_error_handler);
    XSetIOErrorHandler(x_io_error_handler);

    dpy = XOpenDisplay(NULL);
    if (!dpy)
        die(EXIT_IO, "cannot open the target display %s", target_name);
    sdpy = XOpenDisplay(source_name);
    if (!sdpy)
        die(EXIT_IO, "cannot open the source display %s", source_name);
    dscr = DefaultScreen(dpy);
    sscr = DefaultScreen(sdpy);
    droot = RootWindow(dpy, dscr);
    sroot = RootWindow(sdpy, sscr);
    {
        Bool supported;
        XkbSetDetectableAutoRepeat(dpy, True, &supported); /* no fake releases while held */
    }

    check_extensions_and_formats();
    intern_atoms();
    create_window();

    damage = XDamageCreate(sdpy, sroot, XDamageReportNonEmpty);
    damage_region = XFixesCreateRegion(sdpy, NULL, 0);
    XFlush(sdpy);

    in_buf = malloc(IN_INITIAL);
    if (!in_buf)
        die(EXIT_IO, "out of memory");
    in_cap = IN_INITIAL;

    sock_fd = net_connect(socket_path);
    if (fcntl(sock_fd, F_SETFL, fcntl(sock_fd, F_GETFL, 0) | O_NONBLOCK) < 0)
        die(EXIT_IO, "fcntl: %s", strerror(errno));
    handshake();
    DBG("handshake ok; presenting %s on %s", source_name, target_name);

    process_lines(); /* commands that followed `ok` in the same packet */
    run();
    return EXIT_OK;
}
