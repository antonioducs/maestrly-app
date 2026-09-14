# Existing-guest QGA installation validation

On 2026-09-13 the deployment preflight found that the Host installer sent
`guest-file-open` with `mode: wx`. QEMU Guest Agent uses an explicit mode list
and rejects this libc extension. The installer now uses `wb` inside its freshly
created root-only staging directory. The bundle digest is still verified on
both sides before the installer runs.

The regression test first failed with `invalid file open mode 'wx'`, then passed
with the correction. A real Ubuntu phase1 QGA independently reproduced that
rejection and completed the corrected transfer/install/marker verification on
a disposable offline 2 CPU, 2048 MiB, 12 GiB clone. Evidence is retained under
`.host-lab/qga-install-hFwCYf`. QGA's mode validation can also be inspected in
[the upstream source](https://github.com/qemu/qemu/blob/v8.2.2/qga/commands-posix.c#L275).

The source image digest was
`386f969d80b586468e9363c51cef80177d5b8b51fbb0fb94f76d16e1bab337b3`.
The unchanged integrated runtime `0.1.0-20260913-deploy-r1` digest was
`fc58c73bf0d1385ec09cc25ce60c8b2227c02f12ad0ce7624946dfdf67f5c5f5`.
The prior desktop/browser/control qualification for that bundle remains in
`.host-lab/environment-IPIQUz`; this is a limited offline lab resource profile,
not a universal workload minimum or authenticated-provider qualification.

A corrected Host package and scoped template were staged for the selected mini.
The root-owned service/configuration update remains pending an interactive
administrator step. No remote guest preparation or provider login was performed
in this validation. Private staged instructions and checksums are recorded in
`.host-lab/host-bot-config-w7mQLP/READY.md`.
