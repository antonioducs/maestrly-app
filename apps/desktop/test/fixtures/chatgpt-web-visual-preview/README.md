# ChatGPT Web Visual Review smoke

Use this fixture for the acceptance check that cannot be proven by local unit tests: whether the ChatGPT
custom MCP app delivers `content[].type="image"` to the model as vision.

1. Start Maestrly and refresh its connected developer app in ChatGPT.
2. Pair the companion and set Browser / Visual review to **Interact** before starting the session.
3. Ask ChatGPT to call `discover_frontend_previews`; select the candidate whose cwd is
   `test/fixtures/chatgpt-web-visual-preview` when the repository root is exposed, or start a companion rooted
   at this fixture and select cwd `.`.
4. Start `start_review_loop` with `review_scope="frontend"` and that opaque `preview_id`.
5. Call `browser_snapshot` and then `browser_screenshot`. Ask the model which color and geometric shape are
   drawn in the canvas. The initial answer must be a cyan triangle; that information is not present as canvas
   text or in the semantic snapshot.
6. Use snapshot refs to type into “Reviewer note” and click “Change artwork”. Capture a fresh snapshot and
   screenshot. The model must now report a magenta circle.
7. Submit a real visual finding, wait for the executor, reread diff/code, reload or wait for HMR, and capture
   fresh snapshot + screenshot before `finish_review_loop(result="clean")`.
8. Confirm that the banner disappears, port 41789 is no longer reachable, and the visual window closes.
   Confirm separately that the normal drawer browser retained its own cookies/logins and that none appeared in
   the Visual Review window.

Do not accept OCR, DOM text, or the semantic snapshot as proof for step 5. If the model cannot identify the
canvas pixels, the image transport is not working and the smoke fails.
