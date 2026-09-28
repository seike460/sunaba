# Changelog

All notable changes to sunaba are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The four
packages (`sunaba-sdk`, `sunaba-cli`, `sunaba-cdk`, `sunaba-agent`) share
one version number and follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
  short the wait between polls.
- `sunaba-sdk`: `startHooksServer()` answers 400 to a body that is not
  valid JSON and does not call the handler (0.1.0 passed `{}`). A
  handler's error is logged with `console.error`.
- `sunaba-cdk`: the `constructs` peer dependency is `^10.5.0`, the range
  `aws-cdk-lib@2.261.0` already requires.
- `sunaba-cli`: `sunaba --help` lists the flags of each command, including
  `run --idle`, `--suspended` and `--role`.

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
- `sunaba-sdk`: `readFile()` reads a path that starts with `-`.
- `sunaba-sdk`: `buildMicrovmImage()` surfaces errors other than
  not-found (throttling, AccessDenied) while listing the image's existing
  versions, instead of treating the image as new.
- `sunaba-sdk`: `partitionForRegion()` recognizes the ISO and EUSC
  partitions.
- `sunaba-sdk`: the `sunaba-sdk/guest` types resolve under
  `moduleResolution: "node10"`.
- `sunaba-cli`: `sunaba run --json` with a command prints the result as
  JSON.
- `sunaba-cli`: `sunaba logs` reports a `DescribeLogStreams` error such as
  AccessDenied instead of treating it as "no log stream".
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

[Unreleased]: https://github.com/seike460/sunaba/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/seike460/sunaba/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/seike460/sunaba/releases/tag/v0.1.0
