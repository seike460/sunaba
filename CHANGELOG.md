# Changelog

All notable changes to sunaba are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The four
packages (`sunaba-sdk`, `sunaba-cli`, `sunaba-cdk`, `sunaba-agent`) share
one version number and follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] — 2026-09-29

The first npm release since 0.1.0; it includes the 0.1.1 fix.

### Security

- `sunaba-sdk`: `Sandbox.request()` follows a redirect only while it stays
  on the endpoint's origin. A 3xx to another origin, including a
  downgrade to `http:`, is returned to the caller, so the auth token is
  never sent to another host.
- `sunaba-cli`: `sunaba logs` removes control characters from log
  messages before printing them. Code inside the VM writes those messages.
- `sunaba-cdk`: for `MicrovmImageSources.fromBucket()` and
  `fromDirectory()`, the build role gets `s3:GetObject` and
  `s3:GetObjectVersion` on the source object only. It no longer gets
  `s3:List*` and `s3:GetBucket*` on the whole bucket.

### Changed

- `sunaba-sdk`: aborting `waitForMicrovmState()` or
  `waitForImageVersion()` through `signal` throws a `SunabaError`
  with code `"Aborted"` instead of a `TimeoutError`. The abort also cuts
  short the wait between polls, and wins over the result of a poll that
  was in flight when it came.
- `sunaba-sdk`: the waiters reject a `timeoutMs` that is not a number of
  at least 1 with `BadTimeout`, and an `intervalMs` outside 1 to 2^31-1 ms
  with `BadInterval`, before the first poll. A `NaN` timeout used to make
  the wait endless.
- `sunaba-sdk`: `Sandbox.create()` and `connect()` check `runTimeoutMs`
  (`BadTimeout`), `tokenTtlMinutes` (`BadTokenTtl`) and `allowedPorts`
  (`BadPort`) before any API call, so a bad value no longer fails on a
  MicroVM that is already running. `create()` also rejects a
  `maximumDurationSeconds` (`BadMaxDuration`) or idle policy seconds
  (`BadIdlePolicy`) that are not integers 1 to 28800; `NaN` and `0` used
  to be dropped.
- `sunaba-sdk`: `request()` and `websocket()` reject a `port` that is not
  an integer 1 to 65535 (`BadPort`). `websocket()` rejects a `timeoutMs`,
  and `openShellSocket()` a `connectTimeoutMs`, outside 1 to 2^31-1 ms
  (`BadTimeout`).
- `sunaba-sdk`: `buildMicrovmImage()` rejects a `memoryMiB` that is not a
  positive integer (`BadMemory`) and a `buildTimeoutMs` below 1
  (`BadTimeout`) before it uploads anything.
- `sunaba-sdk`: `exec()` (and `readFile()`, which uses it) rejects a
  `maxOutputBytes` that is not a non-negative integer with `BadMaxOutputBytes`,
  and a `timeoutMs` outside 1 to 2^31-1 ms with `BadTimeout`, before
  connecting. Such values used to disable the output cap or fire the
  timeout at once.
- `sunaba-sdk`: `startHooksServer()` answers 400 to a body that is not
  valid JSON and does not call the handler (0.1.0 passed `{}`). A
  handler's error is logged with `console.error`.
- `sunaba-sdk`: `startHooksServer()` from `sunaba-sdk/guest` rejects a
  `maxBodyBytes` that is not a non-negative integer with
  `BadMaxBodyBytes`. `NaN` or `Infinity` turned the body limit off.
- `sunaba-cdk`: the `constructs` peer dependency is `^10.5.0`, the range
  `aws-cdk-lib@2.261.0` already requires.
- `sunaba-cli`: `sunaba --help` lists the flags of each command, including
  `run --idle`, `--suspended` and `--role`.
- `sunaba-cli`: numeric flags accept decimal integers only. An empty
  value such as `--tail=` is no longer read as 0, and `0x10` or `1e3` are
  rejected.
- `sunaba-agent`: `startJsonServer()` and `startHooksServer()` throw a
  `RangeError` for a `maxBodyBytes` that is not a non-negative integer.
  `NaN` or `Infinity` turned the body limit off.
- `sunaba-agent`: a `SUNABA_HOOK_TIMEOUT_MS` that is not a positive number
  (for example `5m`) makes `envHookHandlers()` and `startAgent()` throw a
  `RangeError`, and `sunaba-agentd` exit with code 2. It used to fall back
  to 300000 ms. An empty value still counts as unset.

### Fixed

- All packages: the `LICENSE` files contain the unmodified Apache License
  2.0 text. The 0.1.0 tarballs shipped a modified text that did not match
  the declared `Apache-2.0` license.
- All packages: `exports` has a `default` condition, so CommonJS code can
  `require()` the packages (`require(esm)` needs Node.js ≥ 20.19 or
  ≥ 22.12).
- All packages: the tarballs include `src/`, which the source maps and
  declaration maps point to.
- `sunaba-sdk`: `exec()` decodes a UTF-8 character split across
  WebSocket frames, and `maxOutputBytes` counts UTF-8 bytes.
- `sunaba-sdk`: `exec()` no longer times out when `maxOutputBytes` is
  smaller than its completion marker, or when a background job keeps
  writing to the shell after the command ends.
- `sunaba-sdk`: `readFile()` reads a path that starts with `-`.
- `sunaba-sdk`: `waitForImageVersion()` keeps its 15-minute default when
  `timeoutMs` is passed as `undefined` (it used 120 s).
- `sunaba-sdk`: `buildMicrovmImage()` surfaces errors other than
  not-found (throttling, AccessDenied) while listing the image's existing
  versions, instead of treating the image as new.
- `sunaba-sdk`: `partitionForRegion()` recognizes the ISO and EUSC
  partitions.
- `sunaba-sdk`: the `sunaba-sdk/guest` types resolve under
  `moduleResolution: "node10"`.
- `sunaba-cli`: `sunaba run --json` with a command prints the result as
  JSON.
- `sunaba-cli`: `sunaba logs` reports a `DescribeLogStreams` or
  `GetMicrovm` error such as AccessDenied instead of treating it as "no
  log stream".
- `sunaba-agent`: `startAgent()` no longer leaves the API server listening
  when the hooks server fails to start.
- `sunaba-agent`: `/fs/copy` gives a copied single file the source's mode.
- `sunaba-agent`: `/fs/copy` answers 400 instead of 500 when the copy
  meets a FIFO, a socket or mismatched file types.

## [0.1.1] — 2026-09-28

Tagged and released on GitHub only; not published to npm.

### Added

- `sunaba-sdk`, `sunaba-cdk`: `ManagedIngressConnector.HTTP`
  (`HTTP_INGRESS`).

### Fixed

- `sunaba-sdk`: the default ingress connectors are `HTTP_INGRESS` +
  `SHELL_INGRESS`. The 0.1.0 default, `ALL_INGRESS` + `SHELL_INGRESS`,
  made `Sandbox.create()` and `sunaba run` fail on AWS, because
  `ALL_INGRESS` cannot be combined with other ingress connectors.

## [0.1.0] — 2026-09-28

Initial release. Requires Node.js ≥ 20.

### Added

- `sunaba-sdk`: `Sandbox` lifecycle, exec/shell/fs, managed connectors,
  guest hooks.
- `sunaba-cli`: the `sunaba` command (init/build/run/exec/shell/logs/
  suspend/resume/rm/status/images/ls).
- `sunaba-cdk`: `MicrovmImage`, `MicrovmNetworkConnector`, IAM roles, and
  helpers for managed connector and base image ARNs.
- `sunaba-agent`: the in-VM HTTP agent `sunaba-agentd` (exec/fs/hooks
  API).
- Region and credentials resolve through `AWS_REGION` /
  `AWS_DEFAULT_REGION` or the AWS SDK default provider chain
  (`~/.aws/config` profiles, SSO, IMDS, container metadata). ARNs are
  built for the GovCloud (`aws-us-gov`) and China (`aws-cn`) partitions
  too.

[Unreleased]: https://github.com/seike460/sunaba/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/seike460/sunaba/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/seike460/sunaba/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/seike460/sunaba/releases/tag/v0.1.0
