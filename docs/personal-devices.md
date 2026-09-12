# Personal execution devices

A developer's desktop is a user-owned execution destination. It is absent from shared execution destinations, cannot claim team jobs and accepts only explicit requests made by its owner for that device. Project contributors and maintainers can enable personal execution; viewers cannot. Organization administration does not grant permission to execute on someone else's computer.

## Connect and execute

In the web, open **My computers → Connect my desktop**. Copy the instance URL to desktop **Settings → Platform connections**, connect, and verify the device authorization code in the browser using the same account. The built-in public native OAuth client is discovered from instance metadata. Approval is required; no human token is passed through URLs. Earlier registered OAuth clients remain supported.

Bind each approved project/repository to a local workspace, then enable personal execution. A separate credential tied to the signed-in owner and instance is kept in secure storage (memory only when secure storage is unavailable). Old shared embedded-runner credentials are not reused as personal credentials. Bindings or account disconnection stop the personal worker. Use **Maestrly executor → Only me** and select connected accounts, including subscriptions. **Continue in background** keeps jobs running when the window is closed. **Start with login** restores the saved executor at operating-system login; quitting stops it. See [desktop executor setup](desktop-executor.md). Provider credentials stay on this machine.

On a card choose **Run on my computer**. Select the configured normal column and one of your devices, then review the resolved prompt. Selecting another column uses **Move and execute on my computer**, an atomic request that bypasses the column's shared destination for this job. It does not change the shared column policy or dispatch a duplicate automation. Validation failure rolls back the move. Existing role checks, dispatch limits, snapshot versions, Git isolation, evidence and delivery restrictions apply. Maestrly-provider jobs run unattended under the desktop operator’s saved permissions and do not wait for runtime plans or questions.

An enabled but offline device may receive a queued request if its last advertised capabilities match. The job waits for that exact device. There is no fallback to the shared pool or another computer. Device identity and owner are frozen in the snapshot across retries and continuations. The execution history identifies the personal destination.

## Connection and authorization

The desktop makes outbound HTTPS requests for claims and heartbeats. Heartbeats continue during execution. There is no inbound local HTTP listener, webhook or automatic port exposure. Presence is an indication that an authorized desktop is communicating, not proof that the browser and desktop are on the same physical computer.

The server verifies device ownership on dispatch and checks ownership, project permission, bindings, capabilities and credentials again on claim. Personal devices never claim untargeted or shared jobs. The desktop rejects envelopes addressed to another device or owner before preparing a workspace. Permission loss cancels an active personal lease; revoked credentials prevent further claims. **Disconnect computer** revokes credentials, cancels queued work and requests cancellation of active work. Previously requested work can be inspected by authorized project members like other project executions, without exposing personal device credentials.

The migration preserves existing shared runners and enrollments. The desktop version introducing personal execution must be rebuilt/restarted before use; an older installed desktop still implements its older shared-runner UI.
