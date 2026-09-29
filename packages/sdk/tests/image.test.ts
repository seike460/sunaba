import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMicrovmImage, zipDirectory } from "../src/image.js";
import { ARN, FakeMicrovmsClient } from "./helpers.js";

let tmp: string | undefined;
afterEach(() => {
  vi.useRealTimers();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("zipDirectory", () => {
  it("zips a source dir into a valid zip", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "sunaba-"));
    writeFileSync(path.join(tmp, "Dockerfile"), "FROM scratch\n");
    writeFileSync(path.join(tmp, "app.py"), "print('hi')\n");
    const zip = await zipDirectory(tmp);
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual(["Dockerfile", "app.py"]);
    expect(strFromU8(entries.Dockerfile ?? new Uint8Array())).toContain("FROM scratch");
  });

  it("fails without a Dockerfile", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "sunaba-"));
    writeFileSync(path.join(tmp, "app.py"), "x");
    await expect(zipDirectory(tmp)).rejects.toThrow(/Dockerfile/);
  });

  it("excludes a file literally named __proto__ (fflate prototype-setter)", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "sunaba-"));
    writeFileSync(path.join(tmp, "Dockerfile"), "FROM scratch\n");
    writeFileSync(path.join(tmp, "app.js"), "x\n");
    // fflate's fltn() copies entries into a plain {} — "__proto__" hits
    // the prototype setter and corrupts the archive, so the name is
    // denylisted rather than zipped.
    writeFileSync(path.join(tmp, "__proto__"), "not-a-prototype\n");
    const zip = await zipDirectory(tmp);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(["Dockerfile", "app.js"]);
  });

  it("keeps secrets and noise out of the zip, at any depth", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sunaba-"));
    tmp = dir;
    const put = (rel: string, body = "x\n") => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), body);
    };
    put("Dockerfile", "FROM scratch\n");
    put("app.js");
    put("sub/keep.js");
    // Same fixture as sunaba-cdk's DEFAULT_EXCLUDE_PATTERNS test…
    for (const secret of [
      ".env",
      "id_rsa",
      "cert.pem",
      ".npmrc",
      ".pypirc",
      "prod.tfstate",
      "store.jks",
      ".ssh/id_ed25519",
      ".aws/credentials",
      "node_modules/x.js",
      ".git/config",
      "sub/.env",
      "sub/node_modules/y.js",
      "sub/.ssh/id_ed25519",
      "sub/.env.local",
      "sub/credentials",
      // …plus the rest of the denylist, nested and top-level.
      ".envrc",
      ".netrc",
      ".pgpass",
      ".git-credentials",
      "tls.key",
      "client.p12",
      "client.pfx",
      "app.keystore",
      "putty.ppk",
      "id_dsa",
      "id_ecdsa",
      "terraform.tfstate.backup",
      ".gnupg/pubring.kbx",
      ".kube/config",
      ".docker/config.json",
      ".terraform/terraform.tfstate",
      "sub/.aws/config",
      "sub/.npmrc",
      "sub/deep/id_rsa.pub",
      "sub/deep/.ENV.production",
    ]) {
      put(secret);
    }
    const zip = await zipDirectory(dir);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(["Dockerfile", "app.js", "sub/keep.js"]);
  });

  it("rejects symlinks escaping the source dir", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "sunaba-"));
    writeFileSync(path.join(tmp, "Dockerfile"), "FROM scratch\n");
    symlinkSync(tmpdir(), path.join(tmp, "leak"));
    await expect(zipDirectory(tmp)).rejects.toThrow(/outside the source directory/);
  });

  it("skips in-root symlinks whose target name is denied", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "sunaba-"));
    writeFileSync(path.join(tmp, "Dockerfile"), "FROM scratch\n");
    writeFileSync(path.join(tmp, ".env"), "SECRET=1\n");
    symlinkSync(path.join(tmp, ".env"), path.join(tmp, "notes.txt"));
    const zip = await zipDirectory(tmp);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(["Dockerfile"]);
  });

  it("skips symlinks whose TARGET PATH has a denied segment", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "sunaba-"));
    writeFileSync(path.join(tmp, "Dockerfile"), "FROM scratch\n");
    // .aws/ is denied as a dir, but an innocuously-named symlink could
    // still alias a credential file inside it — check every segment.
    mkdirSync(path.join(tmp, "sub", ".aws", "sso"), { recursive: true });
    writeFileSync(path.join(tmp, "sub", ".aws", "sso", "token.json"), "{}\n");
    symlinkSync(path.join(tmp, "sub", ".aws", "sso", "token.json"), path.join(tmp, "cfg.json"));
    const zip = await zipDirectory(tmp);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(["Dockerfile"]);
  });

  it("does not loop forever on a symlinked-dir cycle", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "sunaba-"));
    writeFileSync(path.join(tmp, "Dockerfile"), "FROM scratch\n");
    mkdirSync(path.join(tmp, "sub"));
    writeFileSync(path.join(tmp, "sub", "a.txt"), "a\n");
    symlinkSync(tmp, path.join(tmp, "sub", "loop"));
    const zip = await zipDirectory(tmp);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(["Dockerfile", "sub/a.txt"]);
  });
});

describe("buildMicrovmImage", () => {
  it("creates the image and waits for its version build", async () => {
    const client = new FakeMicrovmsClient((cmd: any) => {
      const name = cmd.constructor.name as string;
      if (name === "CreateMicrovmImageCommand") return { imageArn: ARN, imageVersion: "1.0" };
      if (name === "GetMicrovmImageVersionCommand") {
        return { state: "SUCCESSFUL", status: "ACTIVE" };
      }
      return {};
    });
    const res = await buildMicrovmImage({
      name: "demo",
      source: { s3Uri: "s3://bucket/key.zip" },
      baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
      buildRoleArn: "arn:aws:iam::123456789012:role/build",
      memoryMiB: 2048,
      environment: { LOG_LEVEL: "info" },
      client,
      region: "us-east-1",
    });
    expect(res).toEqual({ imageArn: ARN, imageVersion: "1.0", state: "SUCCESSFUL" });
    const create = client.callsOf("CreateMicrovmImageCommand")[0];
    expect(create.input.name).toBe("demo");
    expect(create.input.codeArtifact).toEqual({ uri: "s3://bucket/key.zip" });
    expect(create.input.resources).toEqual([{ minimumMemoryInMiB: 2048 }]);
    expect(create.input.environmentVariables).toEqual({ LOG_LEVEL: "info" });
  });

  it("without imageVersion in the response, waits for a version that did not exist before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const old = { imageVersion: "1.0", createdAt: new Date(1) };
    let lists = 0;
    const client = new FakeMicrovmsClient((cmd: any) => {
      const name = cmd.constructor.name as string;
      if (name === "ListMicrovmImagesCommand") {
        return { items: [{ name: "demo", imageArn: ARN }] };
      }
      if (name === "ListMicrovmImageVersionsCommand") {
        lists += 1;
        // The snapshot and the first poll see only the old version.
        return {
          items: lists < 3 ? [old] : [old, { imageVersion: "2.0", createdAt: new Date(2) }],
        };
      }
      if (name === "CreateMicrovmImageCommand") return { imageArn: ARN };
      if (name === "GetMicrovmImageVersionCommand") {
        return { state: "SUCCESSFUL", status: "ACTIVE" };
      }
      return {};
    });
    const building = buildMicrovmImage({
      name: "demo",
      source: { s3Uri: "s3://bucket/key.zip" },
      baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
      buildRoleArn: "arn:aws:iam::123456789012:role/build",
      client,
      region: "us-east-1",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await building;
    expect(res.imageVersion).toBe("2.0");
    expect(lists).toBe(3);
    expect(client.callsOf("GetMicrovmImageVersionCommand")[0].input.imageVersion).toBe("2.0");
  });

  it("fails instead of snapshotting no versions when listing existing ones fails", async () => {
    const throttled = Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
    const client = new FakeMicrovmsClient((cmd: any) => {
      const name = cmd.constructor.name as string;
      if (name === "ListMicrovmImagesCommand") return { items: [{ name: "demo", imageArn: ARN }] };
      if (name === "ListMicrovmImageVersionsCommand") throw throttled;
      if (name === "CreateMicrovmImageCommand") return { imageArn: ARN };
      return {};
    });
    await expect(
      buildMicrovmImage({
        name: "demo",
        source: { s3Uri: "s3://bucket/key.zip" },
        baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
        buildRoleArn: "arn:aws:iam::123456789012:role/build",
        client,
        region: "us-east-1",
      }),
    ).rejects.toBe(throttled);
    expect(client.callsOf("CreateMicrovmImageCommand")).toHaveLength(0);
  });

  it("treats a missing image as having no prior versions", async () => {
    const client = new FakeMicrovmsClient((cmd: any) => {
      const name = cmd.constructor.name as string;
      if (name === "ListMicrovmImagesCommand") return { items: [] };
      if (name === "CreateMicrovmImageCommand") return { imageArn: ARN };
      if (name === "ListMicrovmImageVersionsCommand") {
        return { items: [{ imageVersion: "1.0", createdAt: new Date(1) }] };
      }
      if (name === "GetMicrovmImageVersionCommand") {
        return { state: "SUCCESSFUL", status: "ACTIVE" };
      }
      return {};
    });
    const res = await buildMicrovmImage({
      name: "demo",
      source: { s3Uri: "s3://bucket/key.zip" },
      baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
      buildRoleArn: "arn:aws:iam::123456789012:role/build",
      client,
      region: "us-east-1",
    });
    expect(res.imageVersion).toBe("1.0");
  });

  it("rejects more than one egress connector before any side effect", async () => {
    const client = new FakeMicrovmsClient(() => ({}));
    await expect(
      buildMicrovmImage({
        name: "demo",
        source: { s3Uri: "s3://bucket/key.zip" },
        baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
        buildRoleArn: "arn:aws:iam::123456789012:role/build",
        egressConnectors: ["arn:aws:lambda:us-east-1:aws:network-connector:x:1", "arn:2"],
        client,
        region: "us-east-1",
      }),
    ).rejects.toThrow(/at most 1 egress connector/);
    expect(client.callsOf("CreateMicrovmImageCommand")).toHaveLength(0);
  });

  it.each([
    [{ memoryMiB: Number.NaN }, "BadMemory"],
    [{ memoryMiB: 0 }, "BadMemory"],
    [{ memoryMiB: -1024 }, "BadMemory"],
    [{ memoryMiB: 1024.5 }, "BadMemory"],
    [{ buildTimeoutMs: Number.NaN }, "BadTimeout"],
    [{ buildTimeoutMs: Number.POSITIVE_INFINITY }, "BadTimeout"],
    [{ buildTimeoutMs: 0 }, "BadTimeout"],
  ])("rejects %o with %s before any side effect", async (bad, code) => {
    // Every call "succeeds" at once, so only the option check can fail.
    const client = new FakeMicrovmsClient(() => ({
      imageArn: ARN,
      imageVersion: "1.0",
      state: "SUCCESSFUL",
    }));
    await expect(
      buildMicrovmImage({
        name: "demo",
        source: { s3Uri: "s3://bucket/key.zip" },
        baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
        buildRoleArn: "arn:aws:iam::123456789012:role/build",
        client,
        region: "us-east-1",
        ...bad,
      }),
    ).rejects.toMatchObject({ code });
    expect(client.calls).toHaveLength(0);
  });

  it("accepts exactly one egress connector", async () => {
    const client = new FakeMicrovmsClient((cmd: any) => {
      const name = cmd.constructor.name as string;
      if (name === "CreateMicrovmImageCommand") {
        return { imageArn: ARN, imageVersion: "1.0" };
      }
      if (name === "GetMicrovmImageVersionCommand") {
        return { state: "SUCCESSFUL", status: "ACTIVE" };
      }
      return {};
    });
    const res = await buildMicrovmImage({
      name: "demo",
      source: { s3Uri: "s3://bucket/key.zip" },
      baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
      buildRoleArn: "arn:aws:iam::123456789012:role/build",
      egressConnectors: ["arn:aws:lambda:us-east-1:aws:network-connector:x:1"],
      client,
      region: "us-east-1",
    });
    expect(res.imageArn).toBe(ARN);
    expect(client.callsOf("CreateMicrovmImageCommand")).toHaveLength(1);
  });

  it("uses an injected s3Client without consulting the Lambda region provider", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "sunaba-img-"));
    writeFileSync(path.join(tmp, "Dockerfile"), "FROM scratch\n");
    // Region provider that would break the upload if consulted.
    const client = new FakeMicrovmsClient((cmd: any) => {
      const name = cmd.constructor.name as string;
      if (name === "CreateMicrovmImageCommand") {
        return { imageArn: ARN, imageVersion: "1.0" };
      }
      if (name === "GetMicrovmImageVersionCommand") {
        return { state: "SUCCESSFUL", status: "ACTIVE" };
      }
      return {};
    });
    (client as { config?: unknown }).config = {
      region: () => Promise.reject(new Error("Region is missing")),
    };
    const sent: unknown[] = [];
    const s3Client = {
      send: async (cmd: unknown) => {
        sent.push(cmd);
        return {};
      },
    };
    const res = await buildMicrovmImage({
      name: "demo",
      source: { dir: tmp },
      artifactBucket: "bkt",
      baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
      buildRoleArn: "arn:aws:iam::123456789012:role/build",
      client,
      s3Client,
      // No region anywhere — only the injected S3 client is used.
    });
    expect(sent).toHaveLength(1);
    expect(res.imageArn).toBe(ARN);
  });
});
