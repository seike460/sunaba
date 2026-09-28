/**
 * sunaba quickstart — launch a Lambda MicroVM sandbox, run commands in it,
 * suspend/resume it, then clean up.
 *
 * Prerequisites:
 *   - At the repo root: `npm install && npm run build` (this example
 *     imports sunaba-sdk from packages/sdk/dist)
 *   - AWS credentials allowed lambda:RunMicrovm, lambda:GetMicrovm,
 *     lambda:ListMicrovmImageVersions, lambda:CreateMicrovmShellAuthToken,
 *     lambda:SuspendMicrovm, lambda:ResumeMicrovm, lambda:TerminateMicrovm
 *   - A built image: in examples/demo-image, fill in artifactBucket and
 *     buildRoleArn in sunaba.json (or pass --bucket/--role), then
 *     `sunaba build`
 *   - export SUNABA_IMAGE=arn:aws:lambda:REGION:ACCOUNT:microvm-image:demo
 *
 * Run (in this directory): npm start
 */
import { Sandbox } from "sunaba-sdk";

const image = process.env.SUNABA_IMAGE;
if (!image) {
  console.error("set SUNABA_IMAGE to a MicroVM image ARN (see examples/demo-image)");
  process.exit(1);
}

const sb = await Sandbox.create({
  image,
  // The managed shell connector gives you an agent-free PTY over WebSocket.
  ingress: ["SHELL_INGRESS"],
  egress: ["INTERNET_EGRESS"],
});

try {
  console.log(`sandbox up: ${sb.microvmId} ${sb.endpoint}`);

  // Agent-free exec over the managed shell (SHELL_INGRESS, port 8022).
  const hello = await sb.exec("uname -a && cat /etc/os-release | head -2");
  console.log(hello.output);

  // Files in/out via base64 over the same channel.
  await sb.writeFile("/tmp/note.txt", "hello from sunaba\n");
  const back = await sb.readFile("/tmp/note.txt");
  console.log(`round-trip: ${back.toString().trim()}`);

  // Suspend keeps the snapshot; resume is fast and restores state.
  await sb.suspend();
  console.log("suspended");
  await sb.resume();
  const after = await sb.exec("cat /tmp/note.txt");
  console.log(`after resume: ${after.output.trim()}`);
} finally {
  await sb.terminate();
  console.log("terminated");
}
