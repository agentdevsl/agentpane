/**
 * Build a minimal POSIX USTAR archive containing a single regular file.
 *
 * theme-04 P1-05 / arch29-W2-I (F04-06): Used by sandbox `writeFile` impls
 * (Docker via `putArchive`, K8s/Nomad via `tar xf - -C dir` over exec stdin)
 * to upload files (notably credentials) without going through an exec `sh -c`
 * path that would put the encoded content in argv.
 *
 * The USTAR format is fixed 512-byte blocks: 1 header + N data blocks (padded
 * with zeros) + 2 trailing zero blocks. See `man tar(5)` or
 * https://www.gnu.org/software/tar/manual/html_node/Standard.html.
 */
export function buildSingleFileTar(
  /** File name relative to the extraction directory (NOT the absolute path). */
  name: string,
  content: Buffer,
  mode: number,
  /** UID inside the container (1000 = `node` user in the agent-sandbox image). */
  uid = 1000,
  /** GID inside the container. */
  gid = 1000
): Buffer {
  const nameBytes = Buffer.byteLength(name, 'utf8');
  if (nameBytes > 100) {
    // USTAR short-name field is 100 bytes; we could split into name/prefix but
    // no sandbox path needs it. Fail loud rather than silently truncating.
    throw new Error(`writeFile: name too long for USTAR short-name (${nameBytes} bytes > 100)`);
  }

  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii'); // mode
  header.write(`${uid.toString(8).padStart(7, '0')}\0`, 108, 8, 'ascii'); // uid
  header.write(`${gid.toString(8).padStart(7, '0')}\0`, 116, 8, 'ascii'); // gid
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii'); // size
  header.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, '0')}\0`,
    136,
    12,
    'ascii'
  ); // mtime
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder (8 spaces)
  header.write('0', 156, 1, 'ascii'); // typeflag = '0' (normal file)
  header.write('ustar\0', 257, 6, 'ascii'); // magic
  header.write('00', 263, 2, 'ascii'); // version

  // Compute checksum: unsigned sum of all header bytes (with placeholder)
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i] ?? 0;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

  // Data blocks, padded to 512-byte boundary
  const padLen = (512 - (content.length % 512)) % 512;
  const pad = Buffer.alloc(padLen);
  const trailer = Buffer.alloc(1024); // two zero blocks

  return Buffer.concat([header, content, pad, trailer]);
}

/**
 * Split an absolute container file path into a (parent directory, file name) pair.
 *
 * theme-04 P1-05 / arch29-W2-I: shared by all three providers' `writeFile`
 * implementations. The directory is needed for the `tar xf - -C dir` extraction
 * target; the name goes into the USTAR header.
 */
export function splitContainerPath(filePath: string): { dir: string; name: string } {
  const lastSlash = filePath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash) : '.';
  const name = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  return { dir, name };
}
