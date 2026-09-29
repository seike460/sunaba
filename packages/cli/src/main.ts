#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { flagStr, parseArgs } from "./args.js";
import {
  type CliContext,
  cmdBuild,
  cmdExec,
  cmdImages,
  cmdInit,
  cmdLogs,
  cmdLs,
  cmdResume,
  cmdRm,
  cmdRun,
  cmdShell,
  cmdStatus,
  cmdSuspend,
} from "./commands.js";

const USAGE = `sunaba — sandbox tooling for AWS Lambda MicroVMs

usage: sunaba <command> [flags] [-- args]

commands:
  init      scaffold sunaba.json + Dockerfile in the current directory (--name)
  build     build a MicroVM image (--dir|--zip|--s3-uri, --name, --bucket, --role,
            --base-image, --base-version, --memory MiB, --description, --timeout ms)
  run       launch a sandbox (--image, --image-version, --shell, --exec|-- <cmd>, --rm,
            --role <execution role>, --payload <run hook payload>,
            --max-duration secs, --idle secs, --suspended secs, --no-auto-resume,
            --timeout ms for the command, --run-timeout ms to reach RUNNING)
  exec      run a command in a MicroVM:  sunaba exec <id> [--timeout ms] -- <cmd...>
                                         (or --exec "<cmd>" in place of -- <cmd...>)
  shell     interactive shell:           sunaba shell <id>
  ls        list MicroVMs (--all includes TERMINATED, --image, --image-version)
  images    list MicroVM images
  status    show one MicroVM:            sunaba status <id>
  suspend   suspend MicroVMs:            sunaba suspend <id>... [--timeout ms]
  resume    resume MicroVMs:             sunaba resume <id>... [--timeout ms]
  rm        terminate MicroVMs:          sunaba rm <id>...
  logs      CloudWatch logs:             sunaba logs <id> [--group g] [--follow] [--tail n]

global flags:
  --region <r>    AWS region (or AWS_REGION env)
  --profile <p>   AWS credential profile
  --json          machine-readable output (run, exec, ls, images, status)
  -v, --version   print version
  -h, --help      this help
`;

type Command = (args: ReturnType<typeof parseArgs>, ctx: CliContext) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  init: cmdInit,
  build: cmdBuild,
  run: cmdRun,
  exec: cmdExec,
  shell: cmdShell,
  ls: cmdLs,
  images: cmdImages,
  status: cmdStatus,
  suspend: cmdSuspend,
  resume: cmdResume,
  rm: cmdRm,
  logs: cmdLogs,
};

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const name = args._[0];
  const rest: typeof args = { ...args, _: args._.slice(1) };
  // Only a bare top-level `--version` prints the CLI version. After a
  // command it is that command's flag: `run`/`ls` still take `--version <v>`
  // as an undocumented alias of `--image-version` (shipped in 0.1.0).
  // Direct flag checks — flagBool would throw on "--version x" before the
  // error handler below.
  const wantVersion = args.flags.version === true || args.flags.version === "true";
  const wantHelp = args.flags.help === true || args.flags.help === "true";
  if ((!name && wantVersion) || name === "-v" || name === "version") {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    console.log(pkg.version ?? "0.0.0");
    return 0;
  }
  if (!name || wantHelp || name === "help") {
    console.log(USAGE);
    return name === "help" || wantHelp ? 0 : 1;
  }
  // hasOwn keeps proto keys ("toString", "constructor") out of dispatch.
  const cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!cmd) {
    console.error(`unknown command: ${name}\n`);
    console.error(USAGE);
    return 2;
  }
  try {
    const profile = flagStr(args, "profile");
    if (profile) process.env.AWS_PROFILE = profile;
    const ctx: CliContext = { region: flagStr(args, "region") };
    return await cmd(rest, ctx);
  } catch (e) {
    const err = e as { name?: string; message?: string; code?: string };
    // The SDK's NoRegion error speaks in API terms; add the CLI spelling.
    const hint =
      err?.name === "SunabaError" && err?.code === "NoRegion"
        ? " (use --region or AWS_REGION)"
        : "";
    console.error(`sunaba: error: ${err?.message ?? String(e)}${hint}`);
    return 1;
  }
}

const code = await main();
process.exitCode = code;
