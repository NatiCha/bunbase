import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

/** Owner-only, complete-before-publication credentials. Never follow a symlink. */
export function loadServiceKey(path = ".bunbase-service-key"): string {
  const read = () => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 256)
        throw new Error("BunBase: service key must be a small regular file");
      fchmodSync(fd, 0o600);
      const key = readFileSync(fd, "utf8").trim();
      if (!/^bb_sk_[a-f0-9]{32}$/.test(key))
        throw new Error("BunBase: invalid service key file; restore or explicitly replace it");
      return key;
    } finally {
      closeSync(fd);
    }
  };
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = `bb_sk_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`;
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, key);
    fsyncSync(fd);
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    closeSync(fd);
    unlinkSync(temporary);
  }
  return read(); // Another process may have won exclusive publication.
}
