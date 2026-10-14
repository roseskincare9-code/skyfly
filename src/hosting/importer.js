// Turns an uploaded ZIP or single HTML file into a validated set of files.
// Rejects unsafe archives (path traversal, symlinks, zip bombs, executables).
import { createHash } from 'node:crypto';
import path from 'node:path';
import yauzl from 'yauzl';
import { LIMITS, contentTypeFor, isHtml, isIgnored, normalizePath } from './files.js';
import { analyzeFiles } from './report.js';

export class ImportError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.problems = problems;
  }
}

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (err, zip) => {
      if (err) reject(new ImportError(`This ZIP file can't be read (${err.message}).`));
      else resolve(zip);
    });
  });
}

function readEntry(zip, entry, maxBytes) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(new ImportError(`Can't read "${entry.fileName}" (${err.message}).`));
      const chunks = [];
      let total = 0;
      stream.on('data', (chunk) => {
        total += chunk.length;
        // Counted from real bytes, not the archive's declared size, to stop zip bombs.
        if (total > maxBytes) {
          stream.destroy();
          reject(new ImportError(`"${entry.fileName}" is larger than ${Math.round(LIMITS.fileBytes / 1024 / 1024)} MB.`));
        } else {
          chunks.push(chunk);
        }
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (e) => reject(new ImportError(`Can't read "${entry.fileName}" (${e.message}).`)));
    });
  });
}

async function readZip(buffer) {
  const zip = await openZip(buffer);
  const files = [];
  const problems = [];
  let total = 0;
  let count = 0;

  try {
    await new Promise((resolve, reject) => {
      zip.on('error', (err) => reject(new ImportError(`This ZIP file is damaged or unsafe (${err.message}).`)));
      zip.on('end', resolve);
      zip.on('entry', async (entry) => {
        try {
          const name = entry.fileName;
          count += 1;
          if (count > LIMITS.files) throw new ImportError(`The ZIP contains more than ${LIMITS.files} files.`);
          if (name.endsWith('/') || isIgnored(name)) return zip.readEntry();

          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000) {
            problems.push(`${name}: symbolic links are not allowed`);
            return zip.readEntry();
          }
          if (entry.isEncrypted && entry.isEncrypted()) {
            problems.push(`${name}: encrypted files are not supported`);
            return zip.readEntry();
          }
          const safe = normalizePath(name);
          if (!safe) {
            problems.push(`${name}: unsafe or hidden file name`);
            return zip.readEntry();
          }
          if (!contentTypeFor(safe)) {
            problems.push(`${name}: file type not allowed`);
            return zip.readEntry();
          }
          const data = await readEntry(zip, entry, LIMITS.fileBytes);
          total += data.length;
          if (total > LIMITS.totalBytes) {
            throw new ImportError(`The unpacked files are larger than ${Math.round(LIMITS.totalBytes / 1024 / 1024)} MB.`);
          }
          files.push({ path: safe, data });
          zip.readEntry();
        } catch (err) {
          reject(err);
        }
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  if (problems.length) throw new ImportError('The ZIP contains files Skyfly cannot host safely. Remove them and upload again.', problems);
  return files;
}

// When everything sits inside one folder (common when zipping a folder), drop that folder.
function stripCommonFolder(files) {
  const first = files[0]?.path.split('/')[0];
  if (!first || !files.every((f) => f.path.startsWith(`${first}/`))) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
}

function findEntry(files) {
  const root = files.filter((f) => !f.path.includes('/') && isHtml(f.path));
  const index = root.find((f) => /^index\.html?$/i.test(f.path));
  if (index) return index.path;
  if (root.length === 1) return root[0].path;
  if (root.length === 0) throw new ImportError('No HTML page found at the top level of the ZIP. Add an index.html file.');
  throw new ImportError(`Several HTML pages found (${root.map((f) => f.path).join(', ')}). Name the main one index.html.`);
}

export async function importUpload(file) {
  if (!file?.buffer?.length) throw new ImportError('Choose a .zip or .html file to upload.');
  const name = path.basename(String(file.originalname || 'upload')).slice(0, 200);
  const isZip = file.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  let files;
  if (isZip) {
    files = stripCommonFolder(await readZip(file.buffer));
  } else if (/\.html?$/i.test(name)) {
    const text = file.buffer.toString('utf8');
    if (!/<(html|head|body|!doctype)/i.test(text)) throw new ImportError('This file does not look like an HTML page.');
    files = [{ path: 'index.html', data: file.buffer }];
  } else {
    throw new ImportError('Upload a .zip archive (page plus its files) or a single .html file.');
  }
  if (files.length === 0) throw new ImportError('The ZIP is empty.');

  const entryPath = findEntry(files);
  const prepared = files.map((f) => ({
    ...f,
    size: f.data.length,
    contentType: contentTypeFor(f.path),
    sha256: createHash('sha256').update(f.data).digest('hex'),
  }));
  return {
    sourceName: name,
    entryPath,
    files: prepared,
    totalBytes: prepared.reduce((a, f) => a + f.size, 0),
    report: analyzeFiles(prepared, entryPath, { standalone: !isZip }),
  };
}
