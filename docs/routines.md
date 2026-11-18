# Routines

A routine is an instruction that an agent carries out on its own, on schedule,
on this computer. Each run opens a conversation of its own with the desktop
app's tools—embedded browser, web search, terminals, and files—so the agent
can inspect pages, run commands, and send you an alert only when something
matters. Because every run is a real conversation, you can open it later and
reply to continue from there.

> [!NOTE]
> Local routines run on **this computer** inside the desktop app. If you need
> a routine to keep running when this computer is turned off, use a
> [remote bot's routines](bot-fleet.md) on your server instead.

## Creating a routine

There are three ways to create a routine:

1. **Ask in chat:** Describe what you want in a local chat (for example,
   *"every day at 8am, check the flight price GRU → LIS and alert me if it
   drops"*). When a routine fits, the agent calls `routine_propose` and renders
   a proposal card with the schedule, permissions, model, and alerts. Nothing
   runs until you click **Create routine** (or **Adjust…** to edit first, or
   **Discard**).
2. **From the composer `+` menu:** Type your instruction in the message box,
   click **+**, and choose **Schedule as routine…**. This opens the routine
   editor prefilled with your message text, the conversation's model, and its
   permission mode.
3. **From the Routines section:** Open **Routines** in the sidebar rail and
   click **New routine**.

Routines created from a chat keep a link back to that conversation: the origin
chat displays a clock chip in its header and sidebar row, and a confirmation
card marks where it was created. Each desktop profile supports up to 50 local
routines. Remote hosts do not manage local routines: proposal cards opened on a
remote conversation appear read-only.

## Schedules and missed times

Each routine uses either:

- **Fixed time:** Runs at a specific `HH:MM` clock time on selected weekdays in
  the chosen IANA time zone. Leaving all weekdays unselected runs every day.
- **Interval:** Runs every 15 minutes to 24 hours. If the previous run is still
  active when the next interval arrives, that slot is skipped rather than
  stacking concurrent turns.

Under **If the computer is asleep or Maestrly is closed at the scheduled time**,
choose what happens when Maestrly comes back online:

- **Run when back (up to 2 h late):** Catches up once if the missed slot is
  within two hours; older missed slots are marked **Skipped: computer asleep**
  or **Skipped: Maestrly closed**.
- **Skip:** Records the missed slot as skipped and waits for the next scheduled
  time.

## Run conversations and reports

Every run starts its own standalone conversation tucked inside **Routines** (it
is hidden from the **Chats** list so scheduled runs do not clutter your manual
chats).

- **Shared routine folder:** All runs of a routine share a dedicated folder on
  disk. Files or images generated during a run stay in that folder even after a
  run conversation expires or is deleted.
- **Run reports and memory across runs:** When finishing, the agent calls
  `routine_run_report` with an outcome (**New findings**, **Nothing new**, or
  **Completed**), a one-line summary, optional pending work, and **Notes for
  next run**. The next run automatically receives the previous report so it can
  compare changes over time.
- **Retention and pinning:** By default, run conversations are kept for 30 days
  (configurable per routine: 30, 60, or 90 days, or forever). Open a run's `⋯`
  menu and choose **Always keep** to protect an important run from retention
  pruning, or **Delete conversation** to remove the transcript while keeping its
  report in history and its generated files in the routine folder.

## Permissions and safety

Routines use the same three permission modes as chat:

- **Ask:** Nearly every tool action pauses the run and waits for your approval.
  Useful when supervising the first runs of a new routine.
- **Approve for me (default):** Browser navigation, search, and files inside the
  routine's own folder run autonomously. Commands and external paths pause the
  run until you approve them.
- **Full access:** Nothing pauses. Because nobody is watching while a routine
  runs, untrusted pages with hidden instructions could induce commands on this
  computer; Maestrly displays an amber risk warning wherever this mode is
  selected.

When a run pauses for approval, it enters **Needs you** in both **Routines**
and **Notifications** (and skips overlapping scheduled slots while waiting). You
can approve once, **Always allow in this routine** (saving the rule for future
runs of that routine, removable later in detail or edit view), or deny.

## Model, alerts, and keeping Maestrly running

Each routine stores a snapshot of its provider, model, Reasoning effort, and
Fast mode so scheduled runs always use the chosen configuration even if you switch
models in chat. Change it anytime via **Edit**, or directly from **Switch
routine model** on a failed run card.

Choose when a routine notifies you: **Only when there is news or a problem**
(default), **On every run**, or **Never (history only)**. Failures and approval
requests always notify regardless of this setting.

In **Routines → Schedule**, the **This computer** section controls desktop
background behavior for all local routines:

- **Keep Maestrly running in the background:** Closing the window minimizes
  Maestrly to the system tray instead of quitting, so scheduled times are not
  missed. When off, Maestrly warns you in the Routines sidebar and agenda.
- **Open at system startup:** Starts Maestrly automatically when you log in
  (supported on macOS and Windows).
- **Keep the computer awake during a run:** Prevents system sleep while a
  routine run is actively executing; between runs the computer can sleep
  normally.
