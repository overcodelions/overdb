#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync, readFileSync, readlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ACCOUNT_ID = /(^|[^0-9])([0-9]{12})(?![0-9])/g;
const REDACTED = '[REDACTED:aws-account-id]';

export function findAwsAccountIds(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('latin1') : bytes;
  const findings = [];

  for (const match of text.matchAll(ACCOUNT_ID)) {
    const offset = match.index + match[1].length;
    const before = text.slice(0, offset);
    const lastNewline = before.lastIndexOf('\n');
    findings.push({
      line: before.split('\n').length,
      column: offset - lastNewline,
    });
  }

  return findings;
}

function redactAccountIds(value) {
  return value.replace(ACCOUNT_ID, (_match, prefix) => `${prefix}${REDACTED}`);
}

function annotationProperty(value) {
  return redactAccountIds(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
    .replaceAll(':', '%3A')
    .replaceAll(',', '%2C');
}

function repositoryFiles() {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer' },
  );
  return output.toString('utf8').split('\0').filter(Boolean);
}

// Read a file's bytes, or a symlink's target, without checking first and
// reading second. The open itself decides: O_NOFOLLOW refuses a symlink
// with ELOOP, so the same syscall that would read the file is the one that
// says it is a link, and nothing can be swapped in between (CodeQL
// js/file-system-race). Windows has no O_NOFOLLOW; there the flag is 0 and
// symlinks are not how a checkout stores links anyway.
function readEntry(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    if (err.code === 'ELOOP' || err.code === 'EMLINK') return readlinkSync(file);
    throw err;
  }
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function scanRepository() {
  let count = 0;

  for (const file of repositoryFiles()) {
    const safeFile = annotationProperty(file);
    for (const finding of findAwsAccountIds(file)) {
      count += 1;
      console.error(
        `::error file=${safeFile}::` +
          `AWS account ID detected in a repository path (${REDACTED}); rename the file.`,
      );
    }

    const contents = readEntry(file);
    for (const finding of findAwsAccountIds(contents)) {
      count += 1;
      console.error(
        `::error file=${safeFile},line=${finding.line},col=${finding.column}::` +
          `AWS account ID detected (${REDACTED}); remove or split the fixture value.`,
      );
    }
  }

  if (count > 0) {
    console.error(`Blocked ${count} AWS account ID occurrence${count === 1 ? '' : 's'}. Values were not printed.`);
    process.exitCode = 1;
  } else {
    console.log('No AWS account IDs found in repository files.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  scanRepository();
}
