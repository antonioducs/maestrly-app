# Guest transport

A Node-only JSONL transport shared by the Host and Linux VM supervisor. This
package has no filesystem, command execution, provider, Electron or database
capabilities. Its callers authorize session IDs before accepting a route.

Each route uses its own connection UUID, session generation and sequence counter.
One acknowledged 48 KiB packet per route bounds buffering and permits interleaving
with other routes. Reads apply backpressure, writes preserve order, and half-close
is explicit. Timeout closes a route and never replays its last packet. Physical
wire queues are capped at 4 MiB; malformed envelopes close the physical channel.

The privileged supervisor binds each worker socket through a root-owned,
per-session-group directory. Worker bytes become routed payload, never supervisor
management RPC. The Host checks the VM and session association from its catalogue.

Build with `npm run build:guest-transport`; test with
`npm test --workspace @maestrly/guest-transport`.
