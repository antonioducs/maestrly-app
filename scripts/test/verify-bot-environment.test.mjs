import test from 'node:test'
import assert from 'node:assert/strict'
import { guestScript, browserProbe } from '../verify-bot-environment.mjs'
test('installer digest cannot inject guest shell code', () => {
 assert.throws(()=>guestScript('a; shutdown now'))
 assert.throws(()=>guestScript('a'.repeat(64), '1; shutdown now'))
 assert.match(guestScript('a'.repeat(64)),/--sha256 a{64}/)
})
test('probe uses the installed sandbox policy and the runtime display namespace', () => {
 const script = guestScript('a'.repeat(64), '0.1.0-test')
 assert.match(script, /--version 0\.1\.0-test/)
 assert.match(script, /test -f \/etc\/apparmor.d\/maestrly-chromium/)
 assert.doesNotMatch(script, /cat > \/etc\/apparmor/)
 assert.match(script, /nsenter -t "\$runtime_pid"/)
})
test('browser probe requires non-root and positively checks sandbox',()=>{
 assert.match(browserProbe,/chromiumSandbox:true/)
 assert.match(browserProbe,/process.getuid\(\) === 0/)
 assert.match(browserProbe,/Seccomp-BPF sandbox/)
 assert.doesNotMatch(browserProbe,/--no-sandbox/)
})
