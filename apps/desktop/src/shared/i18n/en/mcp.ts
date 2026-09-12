export default {
  notes: {
    drawer:
      " [EMBEDDED browser in this app's right drawer — NOT the system Chrome. Use these tools to view/control the browser of this window.]",
    term: " Operates on the drawer terminals of THIS conversation. Use these for PERSISTENT or interactive processes the user watches live: dev servers, docker compose up, watch modes, TUIs. For ONE-SHOT commands (git, tests, installs, builds, scripts that just finish) prefer your own shell/bash tool — cleaner output and fewer tokens than the terminal's PTY stream.",
    notes:
      ' ("Notes" notebook of this conversation, visible/editable in the drawer). PREFER it over your own scratch files for notes the user should be able to see/edit.',
    mermaid:
      ' Diagrams: include a ```mermaid code block in the markdown → it renders as a CHART in the tab (flowchart, sequenceDiagram, gantt, classDiagram, etc.). Great for drawing flows/architecture.',
    memory:
      ' (PROJECT memory: durable rules/context available to Chat conversations; editable by the user. PREFER this over private scratch files for project rules the user should see and maintain.)',
    debug:
      ' [Debug of this conversation\'s integrated VS Code. REQUIRES the "Code" tab open. The user follows along in the editor.]',
  },

  tools: {
    // ---------------- BROWSER ----------------
    browser_navigate: {
      title: 'Navigate',
      description: 'Navigates the drawer browser to a URL (or search term).',
      params: { url: 'URL or search term' },
    },
    browser_back: { title: 'Back' },
    browser_forward: { title: 'Forward' },
    browser_reload: { title: 'Reload' },
    browser_nav: {
      reloadDesc: 'Reloads the current page',
      moveDesc: 'Go {{label}} one page',
      descSuffix: ' in the browser of this conversation; waits for the load and returns the URL.',
    },
    browser_wait_for: {
      title: 'Wait',
      description:
        'Waits (up to a timeout) for a condition before proceeding — essential on pages that load content async (SPA). Provide ONE: selector (CSS that must exist), text (must appear on the page) or network_idle (network with no pending requests).',
      params: {
        selector: 'CSS selector that must come to exist',
        text: 'text that must appear in the page body',
        networkIdle: 'waits ~450ms with no pending requests',
        timeoutMs: 'maximum wait time in ms (default 10000)',
      },
    },
    browser_snapshot: {
      title: 'Snapshot',
      description:
        'Lists the visible interactive elements (ref, tag, type, name) of the current page. Use the ref in browser_click/browser_type.',
    },
    browser_click: {
      title: 'Click',
      description: 'Clicks the element of a ref obtained via browser_snapshot.',
      params: { ref: 'element ref (from the snapshot)' },
    },
    browser_double_click: {
      title: 'Double click',
      description: 'Double-clicks the element of a ref obtained via browser_snapshot.',
      params: { ref: 'element ref (from the snapshot)' },
    },
    browser_right_click: {
      title: 'Right click',
      description: 'Right-clicks (opens the context menu) on the element of a ref from the snapshot.',
      params: { ref: 'element ref (from the snapshot)' },
    },
    browser_drag: {
      title: 'Drag',
      description:
        'Drags (drag-and-drop) from the element of one ref to another — useful for sliders and reorderable lists. Take a browser_snapshot first to get the source and target refs.',
      params: {
        fromRef: 'source ref (from the snapshot)',
        toRef: 'target ref (from the snapshot)',
      },
    },
    browser_type: {
      title: 'Type',
      description: 'Focuses the element of a ref and types the text (optionally clearing the field first).',
      params: {
        ref: 'field ref (from the snapshot)',
        text: 'text to type (use "" with clear=true to only clear)',
        clear: 'clears the field before typing (selects all and replaces)',
      },
    },
    browser_press_key: {
      title: 'Key',
      description:
        'Presses a key on the page, with optional modifiers. Keys: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, or a single character (a-z, 0-9). EDITING combos with the OS accelerator perform the native action: select-all (Meta/Control+a), copy (+c), cut (+x), paste (+v), undo (+z), redo (+Shift+z).',
      params: {
        key: 'named key (Enter, ArrowDown, …) or 1 character (a-z, 0-9)',
        modifiers: 'modifiers; on mac use Meta for Cmd (e.g. ["Meta"] + key "a" = select all)',
      },
    },
    browser_read_text: {
      title: 'Read text',
      description: 'Returns the visible text of the current page.',
    },
    browser_screenshot: {
      title: 'Screenshot',
      description:
        'Captures a PNG screenshot of the current page. Image-capable models receive it visually; models without image support get an automatic text description when an image interpreter is configured, otherwise an omission note. Very large viewports are automatically scaled down (aspect ratio preserved, never cropped) to fit the model image limit.',
    },
    browser_evaluate: {
      title: 'Run JS',
      description:
        'Runs JavaScript on the current page (like pasting in the DevTools console: accepts statements; the result is that of the last expression) and returns the serialized result. Promises are awaited. Return a JSON-serializable value — e.g. JSON.stringify(x), x.length, location.href, document.title. The scope PERSISTS across calls (same page context): variables defined stay alive and let/const can be redeclared (replMode); to start fresh, reload the page.',
      params: { expression: 'JavaScript code/expression to evaluate on the page' },
    },
    browser_mouse_move: {
      title: 'Move mouse',
      description:
        'Moves the mouse cursor to coordinates (x, y) in CSS px on the page (origin at the top-left). The position is recorded and reported in browser_snapshot/browser_screenshot.',
      params: {
        x: 'X coordinate in CSS px (0 = left edge)',
        y: 'Y coordinate in CSS px (0 = top)',
      },
    },
    browser_scroll: {
      title: 'Scroll page',
      description:
        'Scrolls the page/container and returns the resulting position (y/maxY). Modes (precedence): selector (brings that element into view) > to (top|bottom) > absolute position (y/x) > delta (dy/dx in px, dy>0 scrolls down). Use container to scroll INSIDE a panel with overflow instead of the window.',
      params: {
        dy: 'vertical delta in px (positive scrolls down)',
        dx: 'horizontal delta in px (positive to the right)',
        y: 'absolute vertical position in px (0 = top)',
        x: 'absolute horizontal position in px',
        to: 'go straight to the top or to the end',
        selector: 'CSS selector of an element to bring into view (scrollIntoView)',
        container: 'CSS selector of the scrollable element to control, instead of the window (nested overflow)',
      },
    },
    browser_console_logs: {
      title: 'Console logs',
      description: 'Returns the console logs (console.log/warn/error and exceptions) captured on the current page.',
      params: {
        level: 'filter by level (e.g. error for errors only)',
        limit: 'maximum number of entries (default 100)',
      },
    },
    browser_network_logs: {
      title: 'Network logs',
      description: 'Returns the network requests (method, URL, status, failures) of the current page.',
      params: {
        onlyErrors: 'only requests that failed or status >= 400',
        limit: 'maximum number of entries (default 100)',
      },
    },
    browser_clear_logs: {
      title: 'Clear logs',
      description: 'Clears the console and network buffers (useful before reproducing a bug).',
    },
    browser_set_dialog_behavior: {
      title: 'Native dialogs',
      description:
        'Sets how native dialogs (alert/confirm/prompt) are auto-answered — they are SYNCHRONOUS and would freeze the page, so they are answered automatically (default: accept) and logged in console_logs. Use accept=false to cancel; prompt_text fills the prompt() when accepted (prompt() is reimplemented via override since Electron does not support it natively).',
      params: {
        accept: 'true = OK/confirm; false = cancel/dismiss',
        promptText: 'text to fill in prompt() when accept=true',
      },
    },
    browser_tabs: {
      title: 'List tabs',
      description:
        "Lists the open tabs of this conversation's browser (index, title, URL) and marks the active one. Use the index in browser_switch_tab/browser_close_tab.",
    },
    browser_switch_tab: {
      title: 'Switch tab',
      description:
        'Makes tab at index N active (1-based, from browser_tabs). From there on the other browser_* operate on it.',
      params: { index: 'tab index (1-based, obtained in browser_tabs)' },
    },
    browser_new_tab: {
      title: 'New tab',
      description: 'Opens a new tab (optionally already navigating to a URL or search term) and makes it active.',
      params: { url: 'URL or search term to open (default: home page)' },
    },
    browser_close_tab: {
      title: 'Close tab',
      description:
        'Closes the tab at index N (1-based, from browser_tabs). If it is the active one, the neighbor becomes active.',
      params: { index: 'index of the tab to close (1-based, obtained in browser_tabs)' },
    },

    // ---------------- TERMINALS ----------------
    terminal_create: {
      title: 'Create terminal',
      description:
        "Creates a new terminal (shell) in this conversation's drawer and returns its id. It shows up in the UI.",
      params: {
        cwd: 'initial directory (default: conversation cwd)',
        cols: 'columns (default 120)',
        rows: 'rows (default 40)',
      },
    },
    terminal_list: {
      title: 'List terminals',
      description: 'Lists the live free terminals of this conversation (id, cwd, pid, process).',
    },
    terminal_send: {
      title: 'Send (raw)',
      description:
        'Writes raw text to the terminal, WITHOUT waiting (like typing). Use to interact or send long/interactive commands; read the result later with terminal_read. Include "\\n" to run a line.',
      params: {
        id: 'terminal id (from terminal_create/terminal_list)',
        text: 'text to write (use \\n for Enter)',
      },
    },
    terminal_run: {
      title: 'Run command',
      description:
        'Writes a command + Enter and waits for the output to stabilize (best effort), returning what was captured. For interactive or long-running commands, prefer terminal_send + terminal_read.',
      params: {
        id: 'terminal id',
        command: 'command to run (without the Enter)',
        timeoutMs: 'max wait time (default 8000)',
      },
    },
    terminal_read: {
      title: 'Read output',
      description: 'Reads the recent output of the terminal (ring buffer history). max_chars limits the size.',
      params: {
        id: 'terminal id',
        maxChars: 'max chars from the END (default everything, ~256KB)',
      },
    },
    terminal_snapshot: {
      title: 'Screen snapshot',
      description:
        'Returns the current rendered SCREEN of the terminal (as the user sees it now), useful for TUIs that redraw in place. For the full history, use terminal_read.',
      params: { id: 'terminal id' },
    },
    terminal_signal: {
      title: 'Signal the process',
      description:
        'Sends a signal to the terminal process WITHOUT closing the tab: SIGINT (Ctrl+C, interrupts), SIGTERM (ends gracefully), SIGKILL (forces). Use terminal_close to close the tab.',
      params: {
        id: 'terminal id',
        signal: 'signal to send',
      },
    },
    terminal_close: {
      title: 'Close terminal',
      description: 'Ends and removes the terminal (kills the shell and closes the tab in the UI).',
      params: { id: 'terminal id' },
    },
    terminal_resize: {
      title: 'Resize',
      description: 'Adjusts the terminal cols/rows (useful before running TUIs).',
      params: {
        id: 'terminal id',
        cols: 'columns',
        rows: 'rows',
      },
    },
    terminal_focus: {
      title: 'Focus in the UI',
      description: "Makes this terminal the active drawer tab and focuses it (in the user's conversation).",
      params: { id: 'terminal id' },
    },
    terminal_clear: {
      title: 'Clear buffer',
      description: "Clears this terminal's captured output history (ring buffer).",
      params: { id: 'terminal id' },
    },

    // ---------------- NOTES ----------------
    notes_list_pages: {
      title: 'List notes pages',
      description: "Lists the pages (tree) of this conversation's notes notebook: id, title, parentId, order.",
    },
    notes_create_page: {
      title: 'Create notes page',
      description: "Creates a new page in the notebook. Use parentId to create a SUB-page. Returns the new page's id.",
      params: {
        title: 'page title',
        parentId: 'id of the parent page (omit for a top-level page)',
      },
    },
    notes_read_page: {
      title: 'Read notes page',
      description: 'Reads the markdown of a page (use notes_list_pages to get the pageId).',
    },
    notes_write_page: {
      title: 'Rewrite notes page',
      description:
        'REPLACES the markdown of a page (headings, lists, checklist `- [ ]`). To only append, use notes_append_page.',
      params: { content: 'the COMPLETE markdown of the page' },
    },
    notes_append_page: {
      title: 'Append to a page',
      description: 'Appends markdown to the END of a page, without rewriting the rest.',
      params: { text: 'markdown to append' },
    },
    notes_delete_page: {
      title: 'Delete notes page',
      description: 'Deletes a page AND its sub-pages (subtree). Irreversible.',
    },
    notes_quick_append: {
      title: 'Quick note',
      description:
        'Appends a snippet to the notebook\'s main page (creates "Notes" if needed). Shortcut to jot a note without picking a page.',
      params: { text: 'markdown to append' },
    },
    project_notes_list_pages: {
      title: 'List project pages',
      description: "Lists the pages (tree) of this repo's PROJECT notebook: id, title, parentId, order.",
    },
    project_notes_create_page: {
      title: 'Create project page',
      description:
        "Creates a new page in the PROJECT notebook. Use parentId to create a SUB-page. Returns the new page's id.",
      params: {
        title: 'page title',
        parentId: 'id of the parent page (omit for a top-level page)',
      },
    },
    project_notes_read_page: {
      title: 'Read project page',
      description:
        'Reads the markdown of a page of the PROJECT notebook (use project_notes_list_pages to get the pageId).',
    },
    project_notes_write_page: {
      title: 'Rewrite project page',
      description:
        'REPLACES the markdown of a page in the PROJECT notebook (headings, lists, checklist `- [ ]`). To only append, use project_notes_append_page.',
      params: { content: 'the COMPLETE markdown of the page' },
    },
    project_notes_append_page: {
      title: 'Append to project page',
      description: 'Appends markdown to the END of a page in the PROJECT notebook, without rewriting the rest.',
      params: { text: 'markdown to append' },
    },
    project_notes_delete_page: {
      title: 'Delete project page',
      description: 'Deletes a page AND its sub-pages (subtree) from the PROJECT notebook. Irreversible.',
    },
    project_notes_quick_append: {
      title: 'Quick project note',
      description:
        'Appends a snippet to the PROJECT notebook\'s main page (creates "Notes" if needed). Shortcut to jot a project note without picking a page.',
      params: { text: 'markdown to append' },
    },

    // ---------------- MEMORY ----------------
    memory_search: {
      title: 'Search project memory',
      description:
        'Narrow hybrid search over durable local memories and versioned .agents/knowledge. Use when prior decisions, constraints, preferences, procedures, or lessons may affect substantive work; skip trivial or self-contained requests. Read-only.',
    },
    memory_list: {
      title: 'List local memories',
      description: 'Lists structured local memories with lifecycle and metadata filters. Read-only.',
    },
    memory_read: {
      title: 'Read project memory',
      description:
        'Reads one specific structured local memory by id after search/list identifies it. Without id, returns a bounded deprecated projection.',
    },
    memory_upsert: {
      title: 'Remember durable information',
      description:
        'Creates or updates one structured memory. Use only for explicitly durable information that can change a future decision; never store hypotheses, raw output, secrets, or temporary state.',
    },
    memory_archive: { title: 'Archive memory', description: 'Reversibly removes a local memory from future searches.' },
    memory_restore: { title: 'Restore memory', description: 'Restores an archived local memory to active status.' },
    memory_forget: {
      title: 'Forget memory permanently',
      description: 'Permanently deletes one local memory. Requires confirm=true.',
    },
    memory_promote_to_shared: {
      title: 'Promote memory to shared knowledge',
      description:
        'Creates or updates a Markdown file under .agents/knowledge after explicit action. Never commits it.',
    },
    memory_write: {
      title: 'Rewrite project memory',
      description:
        'REPLACES the project memory (full markdown). Use for DURABLE rules (commit style, conventions, build/test commands, decisions). To only append, use memory_append.',
      params: { content: 'the COMPLETE markdown of the memory' },
    },
    memory_append: {
      title: 'Append to project memory',
      description: 'Appends a rule/note to the END of the project memory, without rewriting the rest.',
      params: { text: 'markdown to append (e.g. a new rule)' },
    },

    // ---------------- DEBUG ----------------
    debug_status: {
      title: 'Debug status',
      description: 'Current state: active session? stopped/running, thread and location (file:line) where it stopped.',
    },
    debug_start: {
      title: 'Start debug',
      description:
        'Starts a debug session and WAITS for the 1st stop (breakpoint/stopOnEntry). Pass `program` (path to the .js, relative to the repo) for a Node launch, OR `configName` to use a launch.json config. Returns where it stopped.',
      params: {
        program: 'path to the Node entrypoint (relative to the repo or absolute)',
        configName: "name of a configuration from the project's launch.json",
        stopOnEntry: 'stops at the very first line',
        args: 'argv of the program',
      },
    },
    debug_stop: { title: 'Stop debug', description: 'Ends the active debug session.' },
    debug_restart: {
      title: 'Restart debug',
      description: 'Restarts the debug session and waits for the 1st stop.',
    },
    debug_pause: {
      title: 'Pause',
      description: 'Pauses the running program (to inspect wherever it is).',
    },
    debug_continue: {
      title: 'Continue',
      description: 'Continues (play) until the next breakpoint/end. Returns where it stopped (or if it finished).',
    },
    debug_step: {
      title: 'Step instruction',
      description: 'Steps one line: granularity over (default) | into | out. Must be stopped.',
    },
    debug_set_breakpoint: {
      title: 'Add breakpoint',
      description: 'Sets a breakpoint at file:line (conditional via `condition`).',
      params: {
        file: 'file path (relative to the repo or absolute)',
        line: 'line (1-based)',
        condition: 'optional conditional expression',
      },
    },
    debug_remove_breakpoint: {
      title: 'Remove breakpoint',
      description: 'Removes the breakpoint at file:line.',
    },
    debug_clear_breakpoints: { title: 'Clear breakpoints', description: 'Removes ALL breakpoints.' },
    debug_list_breakpoints: {
      title: 'List breakpoints',
      description: 'Lists the current breakpoints (file, line, enabled, condition).',
    },
    debug_stack: {
      title: 'Call stack',
      description: 'Returns the call stack at the stopped point (frames with id/name/file/line).',
    },
    debug_inspect: {
      title: 'Inspect variables',
      description:
        'Scopes + variables in the stopped frame (default: top). Each variable carries a `ref`: use debug_variables to expand objects.',
      params: { frameId: 'frame id (from debug_stack); omit for the top' },
    },
    debug_variables: {
      title: 'Expand variable',
      description: 'Expands an object/array by the `ref` (variablesReference) coming from debug_inspect.',
      params: { ref: 'variablesReference of a composite variable' },
    },
    debug_evaluate: {
      title: 'Evaluate expression',
      description: 'Evaluates an expression in the context of the stopped frame (debugger REPL).',
      params: { expression: 'expression to evaluate' },
    },

  },

  returns: {
    browser: {
      navigated: 'Navigated to {{url}}',
      moved: '{{label}} → {{url}}',
      reloaded: 'Reloaded → {{url}}',
      noHistory: 'No history to go {{label}}.',
      waitOk: 'OK: {{what}} after {{ms}}ms.',
      waitTimeout: 'Timeout: {{what}} did not happen within {{ms}}ms.',
      waitWhatSelector: 'selector "{{selector}}"',
      waitWhatText: 'text "{{text}}"',
      waitWhatNetwork: 'idle network',
      waitWhatNone: '(no condition provided)',
      clicked: 'Clicked ref {{ref}}',
      doubleClicked: 'Double-clicked ref {{ref}}',
      rightClicked: 'Right-clicked ref {{ref}}',
      dragged: 'Dragged from ref {{from}} to ref {{to}}',
      typed: 'Typed in ref {{ref}}',
      clearedTyped: 'Cleared and typed in ref {{ref}}',
      key: 'Key {{combo}}',
      mouseMoved: 'Mouse moved to ({{x}}, {{y}})',
      scroll: 'Scroll at y={{y}}/{{maxY}} ({{pct}}%), x={{x}}/{{maxX}}{{where}}',
      scrollContainer: ' [container {{container}}]',
      screenshotInfo: 'Mouse at ({{x}}, {{y}}) CSS px. Scroll y={{y2}}/{{maxY}} ({{pct}}%).',
      screenshotInfoUnavailable:
        'Mouse at ({{x}}, {{y}}) CSS px. Scroll metadata unavailable; the screenshot is valid ({{error}}).',
      snapshotHead:
        'URL: {{url}}\nViewport: {{width}}x{{height}} CSS px | Scroll: y {{y}}/{{maxY}} ({{pct}}%) | Mouse: ({{mouseX}}, {{mouseY}})',
      noConsoleLogs: '(no console logs captured)',
      noNetworkLogs: '(no requests captured)',
      logsCleared: 'Logs cleared.',
      dialogBehavior: 'Dialogs will be {{action}}{{prompt}}.',
      dialogAccepted: 'accepted',
      dialogCancelled: 'cancelled',
      dialogPrompt: ' (prompt: "{{text}}")',
      noTabs: '(no tabs open)',
      tabActive: 'Active tab: {{index}} — {{label}}',
      tabOpened: 'Tab opened and activated (index {{index}} of {{total}}).',
      tabClosed: 'Tab {{index}} closed.',
      tabRow: '{{index}}.{{active}} {{title}} — {{url}}',
      tabRowActive: ' (active)',
      tabRowNewTitle: 'New tab',
    },
    terminal: {
      created: 'Terminal created: {{id}} (cwd {{cwd}})',
      none: 'No terminal open in this conversation.',
      sent: 'Sent {{chars}} chars to {{id}}.',
      runNoOutput: '(no output captured — it may still be running; use terminal_read)',
      readEmpty: '(no output yet)',
      screenEmpty: '(empty screen)',
      signalSent: 'Sent {{signal}} to {{id}}.',
      closed: 'Terminal {{id}} closed.',
      resized: 'Resized {{id}} to {{cols}}x{{rows}}.',
      focused: 'Focused {{id}}.',
      bufferCleared: 'Buffer of {{id}} cleared.',
    },
    notes: {
      pageCreated: 'Page created: {{id}} ("{{title}}").',
      pageEmpty: '(empty page)',
      pageUpdated: 'Page updated.',
      appended: 'Appended to the page.',
      pageDeleted: 'Page (and sub-pages) deleted.',
      quickAppended: 'Appended to page "{{title}}".',
      quickPageTitle: 'Notes',
    },
    memory: {
      empty: '(empty memory)',
      updated: 'Project memory updated.',
      appended: 'Appended to the project memory.',
    },
  },

  // Agent-facing errors.
  errors: {
    tabNotExist: 'Tab {{index}} does not exist (there are {{total}}).',
    termSpawnFailed: 'The terminal process exited before it was ready.',
    notTermOfConv: 'id "{{id}}" is not a terminal of this conversation.',
    termNotExist: 'terminal "{{id}}" does not exist (or was already closed).',
    termCwdLocked: 'the terminal directory is temporarily locked by a Git branch transition.',
    nothingToReview: 'nothing to review (empty git diff).',
    pageCreateFailed: 'could not create the page',
    convNotFound: 'conversation not found',
    convWsNotFound: 'conversation/workspace not found',
    convNoWorkspace: 'conversation without workspace.',
    convNotInWorkspace: 'this conversation is not in a workspace.',
    debugFailed: 'debug command failed',
  },
} as const
