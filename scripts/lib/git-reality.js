'use strict';

function parsePorcelainPath(line) {
  const text = String(line || '');
  const parts = text.split(' ');
  if (text.startsWith('1 ') && parts.length >= 9) {
    return parts.slice(8).join(' ');
  }
  if (text.startsWith('2 ') && parts.length >= 10) {
    return parts.slice(9).join(' ').split('\t')[0];
  }
  if (text.startsWith('u ') && parts.length >= 11) {
    return parts.slice(10).join(' ');
  }
  if (text.startsWith('? ') || text.startsWith('! ')) {
    return text.slice(2);
  }
  return '';
}

function changedFilesFromPorcelainV2(stdout) {
  return String(stdout || '').split(/\r?\n/).filter((line) => {
    return line.trim() !== '' && !line.startsWith('# ');
  }).map((line) => {
    const status = line.startsWith('? ') || line.startsWith('! ')
      ? line.slice(0, 1)
      : line.slice(2, 4).trim() || 'UNKNOWN';
    const filePath = parsePorcelainPath(line).replace(/\\/g, '/');
    return { status, path: filePath };
  }).filter((item) => item.path);
}

function statusFileMap(files) {
  const map = new Map();
  for (const file of files || []) {
    map.set(file.path, file.status);
  }
  return map;
}

function trackedGitRealityBindingFromHeads(currentHeadValue, checkpointHeadValue, closeoutHeadValue) {
  const checkpointHead = checkpointHeadValue ? String(checkpointHeadValue) : null;
  const closeoutHead = closeoutHeadValue ? String(closeoutHeadValue) : null;
  return {
    current_head: currentHeadValue || 'UNKNOWN',
    checkpoint_head: checkpointHead || 'NOT_RECORDED',
    checkpoint_matches_current_head: Boolean(checkpointHead && currentHeadValue && checkpointHead === currentHeadValue),
    closeout_git_reality_head: closeoutHead || 'NOT_RECORDED',
    closeout_matches_current_head: Boolean(closeoutHead && currentHeadValue && closeoutHead === currentHeadValue),
    proof_boundary: 'Checkpoint and closeout git heads are evidence-time facts; current commit identity must come from git reality and any signed capability head binding.'
  };
}

function trackedGitRealityBinding(currentHeadValue, checkpoint, closeoutEvent) {
  const closeoutGitReality = closeoutEvent &&
    closeoutEvent.payload &&
    closeoutEvent.payload.fact_groups &&
    closeoutEvent.payload.fact_groups.git_reality &&
    typeof closeoutEvent.payload.fact_groups.git_reality === 'object'
    ? closeoutEvent.payload.fact_groups.git_reality
    : null;
  const checkpointHead = checkpoint && checkpoint.head ? checkpoint.head : null;
  const closeoutHead = closeoutGitReality && closeoutGitReality.head ? closeoutGitReality.head : null;
  return trackedGitRealityBindingFromHeads(currentHeadValue, checkpointHead, closeoutHead);
}

function changedFilesFromStatus(stdout) {
  return String(stdout || '').split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => {
    const status = line.slice(0, 2).trim() || 'UNKNOWN';
    const rawPath = line.slice(3).trim();
    const filePath = rawPath.replace(/.* -> /, '').replace(/\\/g, '/');
    return { status, path: filePath || rawPath };
  });
}

module.exports = {
  parsePorcelainPath,
  changedFilesFromPorcelainV2,
  statusFileMap,
  trackedGitRealityBindingFromHeads,
  trackedGitRealityBinding,
  changedFilesFromStatus
};
