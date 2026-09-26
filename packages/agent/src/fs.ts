import { constants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./http.js";

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new HttpError(400, `${name} must be a non-empty string`);
  }
  if (v.includes("\0")) {
    throw new HttpError(400, `${name} must not contain NUL bytes`);
  }
  return v;
}

function encoding(v: unknown): BufferEncoding {
  if (v === undefined || v === "base64") return "base64";
  if (v === "utf8") return "utf8";
  throw new HttpError(400, "encoding must be 'utf8' or 'base64'");
}

function direntType(e: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): string {
  if (e.isSymbolicLink()) return "symlink";
  if (e.isDirectory()) return "directory";
  if (e.isFile()) return "file";
  return "other";
}

async function statResult(p: string) {
  const s = await fsp.lstat(p);
  return {
    type: s.isSymbolicLink()
      ? "symlink"
      : s.isDirectory()
        ? "directory"
        : s.isFile()
          ? "file"
          : "other",
    size: s.size,
    mode: s.mode & 0o7777,
    mtimeMs: s.mtimeMs,
    atimeMs: s.atimeMs,
  };
}

/** Whole-file reads are buffered — cap so a device/huge file can't OOM the VM. */
const MAX_READ_BYTES = 64 * 1024 * 1024;

const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;
const WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_TRUNC |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

export const fsRoutes = {
  /** {path, encoding?} → {data: base64|utf8} */
  "POST /fs/read": async (body: Record<string, unknown>) => {
    const p = str(body.path, "path");
    const enc = encoding(body.encoding);
    // Pin one fd: lstat-then-readFile on the path is TOCTOU — a swapped or
    // growing file could bypass the size cap and OOM the daemon. O_NONBLOCK
    // keeps a FIFO open from pinning a threadpool worker forever.
    const fh = await fsp.open(p, READ_FLAGS);
    try {
      const s = await fh.stat();
      if (!s.isFile()) throw new HttpError(400, "path is not a regular file");
      // Bounded read: stat size alone can't cap a file that grows while we
      // read it — accumulate chunks up to the cap so an appending writer
      // can't OOM the daemon, and don't preallocate the full cap.
      const chunks: Buffer[] = [];
      let total = 0;
      const scratch = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const { bytesRead } = await fh.read(scratch, 0, scratch.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > MAX_READ_BYTES) {
          throw new HttpError(413, `file exceeds ${MAX_READ_BYTES} byte read cap`);
        }
        chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
      }
      const data = Buffer.concat(chunks);
      return { data: enc === "base64" ? data.toString("base64") : data.toString("utf8") };
    } finally {
      await fh.close();
    }
  },

  /** {path, data, encoding?, mode?} → {bytes} */
  "POST /fs/write": async (body: Record<string, unknown>) => {
    const p = str(body.path, "path");
    if (typeof body.data !== "string") throw new HttpError(400, "data must be a string");
    const enc = encoding(body.encoding);
    let buf: Buffer;
    if (enc === "base64") {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.data) || body.data.length % 4 !== 0) {
        throw new HttpError(400, "data is not valid base64");
      }
      buf = Buffer.from(body.data, "base64");
    } else {
      buf = Buffer.from(body.data, "utf8");
    }
    let mode: number | undefined;
    if (body.mode !== undefined) {
      if (
        typeof body.mode !== "number" ||
        !Number.isInteger(body.mode) ||
        body.mode < 0 ||
        body.mode > 0o7777
      ) {
        throw new HttpError(400, "mode must be a number in 0..0o7777");
      }
      mode = body.mode;
    }
    await fsp.mkdir(path.dirname(p), { recursive: true });
    // Pin one fd like the read path: O_NOFOLLOW rejects symlink swaps and
    // O_NONBLOCK turns a FIFO open into ENXIO instead of an endless block.
    const fh = await fsp.open(p, WRITE_FLAGS, mode);
    try {
      const s = await fh.stat();
      if (!s.isFile()) throw new HttpError(400, "path is not a regular file");
      await fh.writeFile(buf);
      if (mode !== undefined) await fh.chmod(mode);
    } finally {
      await fh.close();
    }
    return { bytes: buf.length };
  },

  /** {path} → {entries:[{name,type,size}]} */
  "POST /fs/list": async (body: Record<string, unknown>) => {
    const p = str(body.path, "path");
    const entries = await fsp.readdir(p, { withFileTypes: true });
    const out = await Promise.all(
      entries.map(async (e) => {
        let size: number | null = null;
        try {
          size = (await fsp.lstat(path.join(p, e.name))).size;
        } catch {
          // entry may vanish between readdir and lstat
        }
        return { name: e.name, type: direntType(e), size };
      }),
    );
    return { entries: out };
  },

  /** {path} → stat record */
  "POST /fs/stat": async (body: Record<string, unknown>) => statResult(str(body.path, "path")),

  /** {path, recursive?} → {} */
  "POST /fs/mkdir": async (body: Record<string, unknown>) => {
    await fsp.mkdir(str(body.path, "path"), { recursive: body.recursive !== false });
    return {};
  },

  /** {path, recursive?} → {} — non-empty dirs require recursive:true */
  "POST /fs/remove": async (body: Record<string, unknown>) => {
    await fsp.rm(str(body.path, "path"), { recursive: body.recursive === true, force: false });
    return {};
  },

  /** {from, to} → {} */
  "POST /fs/rename": async (body: Record<string, unknown>) => {
    await fsp.rename(str(body.from, "from"), str(body.to, "to"));
    return {};
  },

  /** {from, to, recursive?} → {} */
  "POST /fs/copy": async (body: Record<string, unknown>) => {
    const from = str(body.from, "from");
    const to = str(body.to, "to");
    const s = await fsp.lstat(from);
    if (s.isDirectory()) {
      if (body.recursive !== true)
        throw new HttpError(400, "recursive:true required for directories");
      await fsp.cp(from, to, { recursive: true });
      return {};
    }
    if (!s.isFile()) {
      throw new HttpError(400, "only regular files and directories can be copied");
    }
    // Fd-pinned copy: a swapped FIFO between lstat and copyFile's internal
    // open would block forever — open both ends with O_NONBLOCK.
    const src = await fsp.open(from, READ_FLAGS);
    try {
      const ss = await src.stat();
      if (!ss.isFile())
        throw new HttpError(400, "only regular files and directories can be copied");
      // Match /fs/write: create missing parent dirs instead of ENOENTing.
      await fsp.mkdir(path.dirname(to), { recursive: true });
      // Open WITHOUT O_TRUNC first: a same-inode dst (same path/hardlink)
      // must be rejected before truncating the source's data.
      const dst = await fsp.open(to, WRITE_FLAGS & ~constants.O_TRUNC);
      try {
        const ds = await dst.stat();
        if (!ds.isFile()) throw new HttpError(400, "destination is not a regular file");
        if (ss.dev === ds.dev && ss.ino === ds.ino) {
          throw new HttpError(400, "source and destination are the same file");
        }
        await dst.truncate(0);
        // writeFile accepts a stream and loops short writes internally —
        // manual `fh.write(chunk)` could silently truncate.
        await dst.writeFile(src.createReadStream());
      } finally {
        await dst.close();
      }
    } finally {
      await src.close();
    }
    return {};
  },
} as const;
