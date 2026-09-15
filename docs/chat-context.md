# Context usage and compaction

The context meter shows how much of the model's working context is occupied.
For Codex (including Astra) and Claude subscriptions, it updates as the runtime
reports new samples, grouping updates within one second. It does not count every
generated character, and the value can decrease after compaction.

Hover over the meter to distinguish the last runtime measurement from the
estimate for the next request. Estimates have a `~` prefix. The next-request
estimate can differ when a native session cannot be resumed. Context occupancy
is separate from accumulated token usage and cost, including subagent work.

Compaction status appears beside the meter. Portable compaction shows the current
chunk or consolidation stage and any retry. Codex native compaction also reports
its lifecycle. After completion, the reduction is shown when a new context sample
or estimate is available. A failure shows its diagnostic and preserves the last
available context observation; it does not mean the context was reduced.

Portable summaries use a three-minute deadline per stage, with one retry for a
stage timeout, empty summary, or transient provider error. Completed stages are
reused within that operation. The total time budget scales with the number of
chunks, up to one hour. Cancellation and authentication/configuration failures
do not trigger retries. The new summary becomes a context boundary only after
all stages finish successfully; original messages remain in visible history.

These observations and progress states are saved with messages. Existing
conversations remain readable; older messages without observations use the
existing context estimate until the runtime reports a new sample.
