document.addEventListener('DOMContentLoaded', () => {
  // --- DOM Elements ---
  const states = {
    landing: document.getElementById('landing-state'),
    brief: document.getElementById('brief-state'),
    assembly: document.getElementById('assembly-state')
  };

  const elements = {
    btnSample: document.getElementById('btn-sample'),
    fileInput: document.getElementById('file-input'),
    dropzone: document.getElementById('dropzone'),
    uploadError: document.getElementById('upload-error'),
    briefInput: document.getElementById('brief-input'),
    clipNotice: document.getElementById('clip-notice'),
    presetChips: document.querySelectorAll('.preset-chip'),
    btnSendBrief: document.getElementById('btn-send-brief'),
    briefError: document.getElementById('brief-error'),
    logText: document.querySelector('.log-text'),
    inventoryLog: document.getElementById('inventory-log'),
    inventoryWarnings: document.getElementById('inventory-warnings'),
    crewLog: document.getElementById('crew-log'),
    directorLog: document.getElementById('director-log'),
    selectorLog: document.getElementById('selector-log'),
    momentCount: document.getElementById('moment-count'),
    momentTableBody: document.getElementById('moment-table-body'),
    momentEmpty: document.getElementById('moment-empty'),
    assemblyMessage: document.getElementById('assembly-message'),
    editorLog: document.getElementById('editor-log'),
    editorCount: document.getElementById('editor-count'),
    editorSummary: document.getElementById('editor-summary'),
    structureNotes: document.getElementById('structure-notes'),
    edlDownloads: document.getElementById('edl-downloads'),
    downloadEdlJson: document.getElementById('download-edl-json'),
    downloadEdlCsv: document.getElementById('download-edl-csv'),
    edlTableBody: document.getElementById('edl-table-body'),
    edlEmpty: document.getElementById('edl-empty'),
    assemblyLog: document.getElementById('assembly-log'),
    roughcutPanel: document.getElementById('roughcut-panel'),
    roughcutPlayer: document.getElementById('roughcut-player'),
    roughcutMeta: document.getElementById('roughcut-meta'),
    directorsNote: document.getElementById('directors-note'),
    cutLabel: document.getElementById('cut-label'),
    reviewerLog: document.getElementById('reviewer-log'),
    reviewPanel: document.getElementById('review-panel'),
    reviewVerdict: document.getElementById('review-verdict'),
    reviewersNote: document.getElementById('reviewers-note'),
    reviewFindings: document.getElementById('review-findings'),
    reviewOrders: document.getElementById('review-orders'),
    downloadRoughcutV1: document.getElementById('download-roughcut-v1'),
    coverageLog: document.getElementById('coverage-log'),
    coveragePanel: document.getElementById('coverage-panel'),
    coverageCount: document.getElementById('coverage-count'),
    coverageSummary: document.getElementById('coverage-summary'),
    coverageGaps: document.getElementById('coverage-gaps'),
    coveragePickups: document.getElementById('coverage-pickups'),
    coverageNote: document.getElementById('coverage-note'),
    downloadPickups: document.getElementById('download-pickups'),
    downloadCoverage: document.getElementById('download-coverage'),
    downloadRoughcut: document.getElementById('download-roughcut'),
    unusedMoments: document.getElementById('unused-moments'),
    runFailure: document.getElementById('run-failure'),
    runFailureMessage: document.getElementById('run-failure-message'),
    btnRetry: document.getElementById('btn-retry'),
    btnStartOver: document.getElementById('btn-start-over'),
    retryError: document.getElementById('retry-error')
  };

  // --- Constants ---
  const MAX_FILES = 10;
  const MAX_SIZE_MB = 200;
  const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
  const VALID_TYPES = ['video/mp4', 'video/quicktime', 'video/x-m4v'];
  const NEUTRAL_TYPES = ['application/octet-stream', 'application/mp4'];

  // --- State Management ---
  // Create or retrieve session identifier
  let sessionId = sessionStorage.getItem('cutroom_session_id');
  if (!sessionId) {
    sessionId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
    sessionStorage.setItem('cutroom_session_id', sessionId);
  }

  function switchState(stateName) {
    Object.keys(states).forEach(key => {
      const el = states[key];
      if (key === stateName) {
        el.style.display = 'flex';
        el.setAttribute('aria-hidden', 'false');
        // Small delay to allow display:flex to apply before transition
        setTimeout(() => el.classList.add('active'), 50);
      } else {
        el.classList.remove('active');
        el.setAttribute('aria-hidden', 'true');
        setTimeout(() => {
          if (!el.classList.contains('active')) {
            el.style.display = 'none';
          }
        }, 500); // Matches CSS transition duration
      }
    });
  }

  function setLoading(element, isLoading) {
    if (isLoading) {
      element.classList.add('is-loading');
      element.disabled = true;
      element.setAttribute('aria-disabled', 'true');
    } else {
      element.classList.remove('is-loading');
      element.disabled = false;
      element.removeAttribute('aria-disabled');
    }
  }

  function formatDuration(seconds) {
    const safeSeconds = Number(seconds) || 0;
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = (safeSeconds % 60).toFixed(1).padStart(4, '0');
    return `${String(minutes).padStart(2, '0')}:${remainder}`;
  }

  function formatFps(fps) {
    if (!Number.isFinite(Number(fps))) return 'fps:unknown';
    const value = Number(fps);
    return `${Number.isInteger(value) ? value : value.toFixed(2)}fps`;
  }

  // Each agent keeps its own accent. Entries are stamped the first time they
  // reach the screen and the stamp is cached, so a re-render never rewrites the
  // clock. Auto-scroll sets scrollTop on the log container itself. Never scroll
  // an element into view here: that scrolls the whole page, not the panel.
  const AGENT_ACCENTS = {
    DIRECTOR: 'director',
    SELECTOR: 'selector',
    EDITOR: 'editor',
    REVIEWER: 'reviewer',
    ASSEMBLY: 'assembly',
    INVENTORY: 'inventory',
    CREW: 'crew'
  };

  const logStamps = new Map();

  function stampFor(key) {
    if (!logStamps.has(key)) {
      const now = new Date();
      const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map(value => String(value).padStart(2, '0'))
        .join(':');
      logStamps.set(key, stamp);
    }
    return logStamps.get(key);
  }

  function renderLogLines(container, logs, fallbackAgent, limit) {
    if (!container) return;
    container.replaceChildren();
    (Array.isArray(logs) ? logs : []).slice(-limit).forEach(entry => {
      const text = String(entry);
      const match = text.match(/^\[([A-Z]+)\]\s*([\s\S]*)$/);
      const agent = match ? match[1] : fallbackAgent;
      const message = match ? match[2] : text;
      const accent = AGENT_ACCENTS[agent] || 'crew';
      const line = document.createElement('div');
      line.className = `log-entry log-entry--${accent}`;
      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = stampFor(`${agent}|${message}`);
      const badge = document.createElement('span');
      badge.className = 'log-badge';
      badge.textContent = agent;
      const body = document.createElement('span');
      body.className = 'log-message';
      body.textContent = message;
      line.append(time, badge, body);
      container.appendChild(line);
    });
    container.scrollTop = container.scrollHeight;
  }

  function renderInventory(inventory, errors) {
    elements.inventoryLog.replaceChildren();
    (inventory || []).forEach(clip => {
      const line = document.createElement('div');
      line.className = 'inventory-line';
      const longFlag = clip.flag ? `  ${clip.flag}` : '';
      line.textContent = `[INVENTORY] ${clip.clip_id}  ${formatDuration(clip.duration_seconds)}  ${clip.resolution}  ${formatFps(clip.fps)}  audio:${clip.has_audio ? 'yes' : 'no'}${longFlag}`;
      elements.inventoryLog.appendChild(line);
    });

    const messages = errors || [];
    elements.inventoryWarnings.textContent = messages.length
      ? `Rejected footage: ${messages.join(' · ')}`
      : '';
    elements.clipNotice.textContent = messages.length
      ? `The readable clips are ready. Rejected: ${messages.join(' · ')}`
      : '';
  }

  function renderCrewStatus(status, error) {
    elements.crewLog.textContent = status
      ? `[CREW] ${status}`
      : (error ? `[CREW] ${error}` : '');
  }

  function renderDirector(data) {
    const logs = Array.isArray(data?.directorLog) ? data.directorLog : [];
    const lines = !logs.length && data?.directorStatus === 'running'
      ? ['[DIRECTOR] interpreting the brief...']
      : logs;
    renderLogLines(elements.directorLog, lines, 'DIRECTOR', 8);
  }

  function renderSelector(data) {
    renderLogLines(elements.selectorLog, data?.selectorLog, 'SELECTOR', 12);

    const moments = Array.isArray(data?.moments) ? data.moments : [];
    elements.momentCount.textContent = `${moments.length} ${moments.length === 1 ? 'moment' : 'moments'}`;
    elements.momentTableBody.replaceChildren();
    moments.forEach(moment => {
      const row = document.createElement('tr');
      const values = [
        moment.filename || moment.clip_id || 'unknown',
        `${formatDuration(moment.start_sec)} → ${formatDuration(moment.end_sec)}`,
        moment.action || '-',
        [moment.shot_size, moment.camera_motion].filter(Boolean).join(' · ') || '-',
        Number.isFinite(Number(moment.intent_score))
          ? `${Math.round(Number(moment.intent_score) * 100)}%`
          : '-',
        moment.notes || '-'
      ];
      values.forEach(value => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      });
      elements.momentTableBody.appendChild(row);
    });
    elements.momentEmpty.hidden = moments.length > 0;
  }

  function renderEditor(data) {
    renderLogLines(elements.editorLog, data?.editorLog, 'EDITOR', 8);

    const result = data?.editorResult;
    const edits = Array.isArray(result?.edl) ? result.edl : [];
    elements.editorCount.textContent = edits.length
      ? `${edits.length} ${edits.length === 1 ? 'edit' : 'edits'} · ${formatDuration(result.total_duration_sec)}`
      : '';
    elements.editorSummary.textContent = result?.summary || '';
    elements.structureNotes.replaceChildren();
    (Array.isArray(result?.structure_notes) ? result.structure_notes : []).forEach(note => {
      const item = document.createElement('li');
      item.textContent = note;
      elements.structureNotes.appendChild(item);
    });

    elements.edlTableBody.replaceChildren();
    edits.forEach(edit => {
      const row = document.createElement('tr');
      const values = [
        edit.edit_index || '-',
        edit.filename || edit.clip_id || 'unknown',
        `${formatDuration(edit.source_start_sec)} → ${formatDuration(edit.source_end_sec)}`,
        formatDuration(edit.duration_sec),
        edit.role || '-',
        edit.action || '-'
      ];
      values.forEach(value => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      });
      elements.edlTableBody.appendChild(row);
    });
    elements.edlEmpty.hidden = edits.length > 0;

    const unused = Array.isArray(result?.unused_strong_moments)
      ? result.unused_strong_moments
      : [];
    elements.unusedMoments.replaceChildren();
    if (unused.length) {
      const heading = document.createElement('h3');
      heading.textContent = `Unused strong moments (${unused.length})`;
      elements.unusedMoments.appendChild(heading);
      unused.forEach(moment => {
        const item = document.createElement('div');
        item.className = 'unused-moment';
        item.textContent = `${moment.filename || moment.clip_id} ${formatDuration(moment.start_sec)} → ${formatDuration(moment.end_sec)} · ${moment.action || 'moment'} - ${moment.reason || 'held back'}`;
        elements.unusedMoments.appendChild(item);
      });
    }

    const ready = data?.editorStatus === 'complete';
    elements.edlDownloads.hidden = !ready;
    if (ready) {
      elements.downloadEdlJson.href = `/api/session/edl.json?sessionId=${encodeURIComponent(sessionId)}`;
      elements.downloadEdlCsv.href = `/api/session/edl.csv?sessionId=${encodeURIComponent(sessionId)}`;
    }
    elements.downloadRoughcut.hidden = data?.assemblyStatus !== 'complete';
  }

  function appendFindingGroup(container, heading, items) {
    if (!Array.isArray(items) || items.length === 0) return;
    const group = document.createElement('div');
    group.className = 'finding-group';
    const title = document.createElement('h3');
    title.textContent = heading;
    group.appendChild(title);
    const list = document.createElement('ul');
    items.forEach(item => {
      const entry = document.createElement('li');
      entry.textContent = item;
      list.appendChild(entry);
    });
    group.appendChild(list);
    container.appendChild(group);
  }

  function renderReview(data) {
    const review = data?.reviewerResult;
    elements.reviewPanel.hidden = !review;
    if (!review) return;

    const orders = Array.isArray(data?.appliedOrders) ? data.appliedOrders : [];
    const runtime = Number(review.watched_runtime_sec);
    const runtimeLabel = Number.isFinite(runtime) && runtime > 0
      ? ` · watched ${runtime.toFixed(1)}s`
      : '';
    elements.reviewVerdict.textContent =
      `${review.verdict === 'one_pass' ? 'one pass' : 'ship'}${runtimeLabel}`;
    elements.reviewersNote.textContent = review.reviewers_note || '';

    elements.reviewFindings.replaceChildren();
    appendFindingGroup(elements.reviewFindings, 'Pacing', review.pacing_findings);
    appendFindingGroup(elements.reviewFindings, 'Continuity', review.continuity_findings);
    appendFindingGroup(elements.reviewFindings, 'Repetition', review.repetition_findings);

    elements.reviewOrders.replaceChildren();
    if (orders.length) {
      const heading = document.createElement('h3');
      heading.textContent = `Orders applied (${orders.length})`;
      elements.reviewOrders.appendChild(heading);
      orders.forEach(order => {
        const item = document.createElement('div');
        item.className = 'review-order';
        const title = document.createElement('p');
        title.className = 'review-order-title';
        title.textContent = `${String(order.op || 'order').toUpperCase()} position ${order.position} · ${order.detail || ''}`;
        const reason = document.createElement('p');
        reason.className = 'review-order-reason';
        reason.textContent = order.reason || '';
        const before = document.createElement('p');
        before.className = 'review-order-line';
        before.textContent = `before: ${order.before || ''}`;
        const after = document.createElement('p');
        after.className = 'review-order-line';
        after.textContent = `after: ${order.after || ''}`;
        item.append(title, reason, before, after);
        elements.reviewOrders.appendChild(item);
      });
    }

    const skipped = Array.isArray(data?.skippedOrders) ? data.skippedOrders : [];
    if (skipped.length) {
      appendFindingGroup(elements.reviewOrders, 'Orders skipped', skipped);
    }
  }

  // COVERAGE is the fifth chair: it reads the crew's census after the review and
  // writes the pickup list for the next shoot. It never blocks the cut, so the panel
  // simply appears when coverage.json lands.
  function renderCoverage(data) {
    const coverage = data?.coverageResult;
    const ready = data?.coverageStatus === 'complete' && coverage;
    elements.coveragePanel.hidden = !ready;
    elements.downloadPickups.hidden = !ready;
    elements.downloadCoverage.hidden = !ready;
    if (!ready) return;

    elements.downloadPickups.href =
      `/api/session/pickups.txt?sessionId=${encodeURIComponent(sessionId)}`;
    elements.downloadCoverage.href =
      `/api/session/coverage.json?sessionId=${encodeURIComponent(sessionId)}`;

    const gaps = Array.isArray(coverage.gaps) ? coverage.gaps : [];
    const pickups = Array.isArray(coverage.pickups) ? coverage.pickups : [];
    const roll = Math.ceil(Number(coverage.total_roll_sec) || 0);
    elements.coverageCount.textContent = gaps.length
      ? `${gaps.length} ${gaps.length === 1 ? 'gap' : 'gaps'} · ${pickups.length} ${pickups.length === 1 ? 'pickup' : 'pickups'} · roll about ${roll}s`
      : 'no gaps';
    elements.coverageSummary.textContent = coverage.coverage_summary || '';

    elements.coverageGaps.replaceChildren();
    if (gaps.length) {
      const heading = document.createElement('h3');
      heading.textContent = 'What the footage is missing';
      elements.coverageGaps.appendChild(heading);
      gaps.forEach(gap => {
        const item = document.createElement('div');
        item.className = `coverage-gap severity-${gap.severity || 'should'}`;
        const title = document.createElement('p');
        title.className = 'coverage-gap-title';
        title.textContent = `${gap.gap_index}. ${String(gap.severity || '').toUpperCase()} · ${gap.gap_type} · ${gap.what_is_missing || ''}`;
        item.appendChild(title);
        if (gap.why_the_cut_needs_it) {
          const why = document.createElement('p');
          why.className = 'coverage-gap-line';
          why.textContent = `why: ${gap.why_the_cut_needs_it}`;
          item.appendChild(why);
        }
        if (gap.evidence) {
          const evidence = document.createElement('p');
          evidence.className = 'coverage-gap-line';
          evidence.textContent = `evidence: ${gap.evidence}`;
          item.appendChild(evidence);
        }
        elements.coverageGaps.appendChild(item);
      });
    }

    elements.coveragePickups.replaceChildren();
    if (pickups.length) {
      const heading = document.createElement('h3');
      heading.textContent = 'Shot list, most important first';
      elements.coveragePickups.appendChild(heading);
      const list = document.createElement('ol');
      list.className = 'coverage-pickup-list';
      pickups.forEach(pickup => {
        const item = document.createElement('li');
        item.className = 'coverage-pickup';
        const title = document.createElement('p');
        title.className = 'coverage-pickup-title';
        const serves = pickup.serves_gap ? ` · gap ${pickup.serves_gap}` : '';
        title.textContent = `${pickup.shot_size} · roll ${pickup.duration_sec}s${serves}`;
        const shot = document.createElement('p');
        shot.className = 'coverage-pickup-shot';
        shot.textContent = pickup.shot || '';
        item.append(title, shot);
        const detail = [pickup.movement ? `movement: ${pickup.movement}` : '', pickup.camera_note ? `camera: ${pickup.camera_note}` : '']
          .filter(Boolean)
          .join(' · ');
        if (detail) {
          const line = document.createElement('p');
          line.className = 'coverage-gap-line';
          line.textContent = detail;
          item.appendChild(line);
        }
        list.appendChild(item);
      });
      elements.coveragePickups.appendChild(list);
    }

    const skipped = Array.isArray(coverage.skipped) ? coverage.skipped : [];
    if (skipped.length) {
      appendFindingGroup(elements.coveragePickups, 'Left out by validation', skipped);
    }
    elements.coverageNote.textContent = coverage.next_shoot_note
      ? `First hour tomorrow: ${coverage.next_shoot_note}`
      : '';
  }

  let roughcutLoadedFor = '';

  function renderAssembly(data) {
    renderLogLines(elements.assemblyLog, data?.assemblyLog, 'ASSEMBLY', 8);
    renderLogLines(elements.reviewerLog, data?.reviewerLog, 'REVIEWER', 12);
    renderLogLines(elements.coverageLog, data?.coverageLog, 'COVERAGE', 6);
    renderCoverage(data);

    elements.directorsNote.textContent = data?.directorsNote
      ? `Director's note: ${data.directorsNote}`
      : '';

    renderReview(data);

    const cut = data?.roughCut;
    const complete = data?.assemblyStatus === 'complete' && cut;
    elements.roughcutPanel.hidden = !complete;
    if (!complete) {
      roughcutLoadedFor = '';
      return;
    }

    const isSecondCut = Number(data?.cutVersion) === 2;
    elements.cutLabel.textContent = isSecondCut
      ? 'Cut v2 (after review)'
      : 'Rough cut';
    elements.downloadRoughcutV1.hidden = !data?.hasRoughCutV1;
    if (data?.hasRoughCutV1) {
      elements.downloadRoughcutV1.href =
        `/api/session/roughcut_v1.mp4?sessionId=${encodeURIComponent(sessionId)}`;
    }

    const source = `/api/session/roughcut.mp4?sessionId=${encodeURIComponent(sessionId)}`;
    if (roughcutLoadedFor !== source) {
      elements.roughcutPlayer.src = source;
      elements.downloadRoughcut.href = source;
      roughcutLoadedFor = source;
    }
    const fps = Number.isFinite(Number(cut.fps)) ? `${Number(cut.fps)}fps` : 'fps unknown';
    const megabytes = (Number(cut.sizeBytes) || 0) / (1024 * 1024);
    elements.roughcutMeta.textContent =
      `${cut.shots} shots · ${cut.durationSec}s · ${fps} · ${cut.height}p · ${cut.videoCodec}/${cut.audioCodec} · ${megabytes.toFixed(1)}MB`;
  }

  function renderRunFailure(data) {
    const failure = data && data.runFailure;
    const show = Boolean(failure && failure.message);
    elements.runFailure.hidden = !show;
    if (!show) return;
    elements.runFailureMessage.textContent = failure.message;
    elements.btnRetry.hidden = !data.canRetry;
  }

  function renderAssemblyMessage(data) {
    renderRunFailure(data);
    if (data?.status === 'completed') {
      elements.assemblyMessage.textContent =
        data?.assemblyStatus === 'complete'
          ? (Number(data?.cutVersion) === 2
              ? 'Cut v2 is ready after the review. Play it, then take the MP4 or the EDL.'
              : 'The rough cut is ready. Play it, then take the MP4 or the EDL.')
          : 'Assembly complete. Your EDL is ready to download.';
      elements.assemblyMessage.classList.remove('blink');
      elements.assemblyMessage.style.color = 'var(--amber)';
    } else if (data?.status === 'error') {
      elements.assemblyMessage.textContent =
        data.assemblyError ||
        data.editorError ||
        data.directorError ||
        data.selectorError ||
        'The crew finished with errors.';
      elements.assemblyMessage.classList.remove('blink');
      elements.assemblyMessage.style.color = 'var(--error)';
    } else {
      elements.assemblyMessage.textContent = 'The crew is assembling...';
      elements.assemblyMessage.classList.add('blink');
      elements.assemblyMessage.style.color = '';
    }
  }

  // --- Landing State Handlers ---

  elements.btnSample.addEventListener('click', async () => {
    elements.uploadError.textContent = '';
    setLoading(elements.btnSample, true);
    
    try {
      const res = await fetch('/api/session/sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const details = Array.isArray(data.invalidFiles) ? ` ${data.invalidFiles.join(' · ')}` : '';
        throw new Error((data.error || 'Failed to prepare sample footage.') + details);
      }
      
       const data = await res.json();
       if (data.inventoryErrors) {
         renderInventory(data.inventory, data.inventoryErrors);
       }
       switchState('brief');
    } catch (err) {
      elements.uploadError.textContent = err.message;
    } finally {
      setLoading(elements.btnSample, false);
    }
  });

  // Drag and Drop
  const preventDefaults = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    elements.dropzone.addEventListener(eventName, preventDefaults, false);
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    elements.dropzone.addEventListener(eventName, () => {
      if (!elements.dropzone.classList.contains('is-loading')) {
        elements.dropzone.classList.add('dragover');
      }
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    elements.dropzone.addEventListener(eventName, () => {
      elements.dropzone.classList.remove('dragover');
    }, false);
  });

  elements.dropzone.addEventListener('drop', (e) => {
    if (!elements.dropzone.classList.contains('is-loading')) {
      handleFiles(e.dataTransfer.files);
    }
  }, false);

  elements.dropzone.addEventListener('click', () => {
    if (!elements.dropzone.classList.contains('is-loading')) {
      elements.fileInput.click();
    }
  });

  elements.dropzone.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !elements.dropzone.classList.contains('is-loading')) {
      e.preventDefault();
      elements.fileInput.click();
    }
  });

  elements.fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
  });

  async function handleFiles(files) {
    if (!files || files.length === 0) return;
    
    elements.uploadError.textContent = '';
    
    if (files.length > MAX_FILES) {
      elements.uploadError.textContent = `A session can contain up to ${MAX_FILES} clips. You picked ${files.length}.`;
      elements.fileInput.value = '';
      return;
    }

    let totalSize = 0;
    const formData = new FormData();
    formData.append('sessionId', sessionId);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const name = file.name.toLowerCase();
      const hasVideoExtension = name.endsWith('.mp4') || name.endsWith('.mov');
      const type = (file.type || '').toLowerCase().split(';')[0].trim();

      if (!hasVideoExtension) {
        elements.uploadError.textContent = `${file.name} is not a .mp4 or .mov file. Only .mp4 or .mov footage is accepted.`;
        elements.fileInput.value = '';
        return;
      }
      // A browser that reports a type has to report a video one. An empty type
      // or octet-stream (common for files dragged off an external drive) still
      // gets probed with ffprobe on the server.
      if (type && !VALID_TYPES.includes(type) && !NEUTRAL_TYPES.includes(type)) {
        elements.uploadError.textContent = `${file.name} is a ${type} file, not video. Only .mp4 or .mov footage is accepted.`;
        elements.fileInput.value = '';
        return;
      }
      if (file.size > MAX_SIZE_BYTES) {
        elements.uploadError.textContent = `${file.name} is larger than the ${MAX_SIZE_MB}MB session limit.`;
        elements.fileInput.value = '';
        return;
      }
      totalSize += file.size;
      formData.append('clips', file);
    }

    if (totalSize > MAX_SIZE_BYTES) {
      elements.uploadError.textContent = `That footage is ${(totalSize / (1024 * 1024)).toFixed(0)}MB, over the ${MAX_SIZE_MB}MB session limit.`;
      elements.fileInput.value = '';
      return;
    }

    setLoading(elements.dropzone, true);
    const dropText = elements.dropzone.querySelector('.drop-text');
    const originalText = dropText.textContent;
    dropText.textContent = 'Uploading footage...';
    
    try {
      const res = await fetch('/api/session/clips', {
        method: 'POST',
        body: formData
      });
      
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const details = Array.isArray(data.invalidFiles) ? ` ${data.invalidFiles.join(' · ')}` : '';
        throw new Error((data.error || 'Upload failed. Please try again.') + details);
      }
      
       const data = await res.json();
       renderInventory(data.inventory, data.inventoryErrors);
       switchState('brief');
    } catch (err) {
      elements.uploadError.textContent = err.message;
    } finally {
      dropText.textContent = originalText;
      setLoading(elements.dropzone, false);
      elements.fileInput.value = ''; 
    }
  }

  // --- Brief State Handlers ---

  let selectedPreset = '';

  elements.presetChips.forEach(chip => {
    chip.addEventListener('click', () => {
      const newPreset = chip.textContent.trim();
      selectedPreset = selectedPreset === newPreset ? '' : newPreset;
      elements.presetChips.forEach(item => {
        const isSelected = item.textContent.trim() === selectedPreset;
        item.classList.toggle('selected', isSelected);
        item.setAttribute('aria-pressed', String(isSelected));
      });
      elements.briefInput.focus();
    });
  });

  elements.btnSendBrief.addEventListener('click', async () => {
    const brief = elements.briefInput.value.trim();
    // An empty brief is allowed. The server falls back to the house default
    // and the director log says which default it took.
    elements.briefError.textContent = '';
    setLoading(elements.btnSendBrief, true);

    try {
      const res = await fetch('/api/session/brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, brief, preset: selectedPreset })
      });
      
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to send brief. Please try again.');
      }
      
       const data = await res.json();
       renderInventory(data.inventory, data.inventoryErrors);
       renderCrewStatus(data.crewStatus, data.crewStatusError);
        renderDirector(data);
        renderSelector(data);
        renderEditor(data);
        renderAssembly(data);
        renderAssemblyMessage(data);
       switchState('assembly');
      startStatusPolling();
    } catch (err) {
      elements.briefError.textContent = err.message;
    } finally {
      setLoading(elements.btnSendBrief, false);
    }
  });

  // --- Assembly State Handlers ---
  let pollInterval;
  
  function startStatusPolling() {
    if (pollInterval) clearInterval(pollInterval);
    
    pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/session?sessionId=${sessionId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'completed') {
            clearInterval(pollInterval);
             renderSelector(data);
              renderDirector(data);
              renderEditor(data);
        renderAssembly(data);
             renderAssemblyMessage(data);
              elements.logText.textContent =
                data.assemblyStatus === 'complete'
                  ? 'The rough cut is ready. Play it, then take the MP4 or the EDL.'
                  : 'Assembly complete. Your EDL is ready to download.';
             elements.logText.classList.remove('blink');
          } else if (data.status === 'error') {
            clearInterval(pollInterval);
             renderSelector(data);
              renderDirector(data);
              renderEditor(data);
        renderAssembly(data);
             renderAssemblyMessage(data);
              elements.logText.textContent = 'The crew finished with errors. Review the logs above.';
            elements.logText.classList.remove('blink');
            elements.logText.style.color = 'var(--error)';
           } else {
             renderSelector(data);
             renderDirector(data);
             renderEditor(data);
        renderAssembly(data);
             renderAssemblyMessage(data);
          }
        }
      } catch (err) {
        // Silently fail polling to avoid interrupting the visual experience
      }
    }, 2000);
  }

  // --- Failure recovery ---

  elements.btnRetry.addEventListener('click', async () => {
    elements.retryError.textContent = '';
    setLoading(elements.btnRetry, true);
    try {
      const res = await fetch('/api/session/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'The retry could not start. Try again in a moment.');
      }
      const data = await res.json();
      elements.runFailure.hidden = true;
      elements.logText.style.color = '';
      renderDirector(data);
      renderSelector(data);
      renderEditor(data);
      renderAssembly(data);
      renderAssemblyMessage(data);
      startStatusPolling();
    } catch (err) {
      elements.retryError.textContent = err.message;
    } finally {
      setLoading(elements.btnRetry, false);
    }
  });

  elements.btnStartOver.addEventListener('click', async () => {
    elements.retryError.textContent = '';
    setLoading(elements.btnStartOver, true);
    try {
      const res = await fetch('/api/session/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      if (!res.ok) throw new Error('Could not clear this session. Reload the page.');
      const data = await res.json();
      sessionId = data.sessionId || data.id || sessionId;
      sessionStorage.setItem('cutroom_session_id', sessionId);
      if (pollInterval) clearInterval(pollInterval);
      elements.runFailure.hidden = true;
      elements.uploadError.textContent = '';
      elements.logText.style.color = '';
      switchState('landing');
    } catch (err) {
      elements.retryError.textContent = err.message;
    } finally {
      setLoading(elements.btnStartOver, false);
    }
  });

  // --- Initialization ---
  async function init() {
    try {
      const res = await fetch(`/api/session?sessionId=${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        sessionId = data.sessionId || data.id || sessionId;
        sessionStorage.setItem('cutroom_session_id', sessionId);
        renderInventory(data.inventory, data.inventoryErrors);
        renderCrewStatus(data.crewStatus, data.crewStatusError);
        renderDirector(data);
        renderSelector(data);
        renderEditor(data);
        renderAssembly(data);
        renderAssemblyMessage(data);
        if (data.status === 'assembling') {
          switchState('assembly');
          startStatusPolling();
          return;
        } else if (data.status === 'error' || data.status === 'completed') {
          // A reload after a failed or finished run belongs in the cutting
          // room, with the log, the apology and the retry button, not back on
          // the brief screen with no explanation.
          switchState('assembly');
          if (data.status === 'error') {
            elements.logText.style.color = 'var(--error)';
          }
          return;
        } else if (data.clipCount > 0) {
          switchState('brief');
          return;
        }
      }
    } catch (e) {
      // API might not exist yet, default to landing
    }
    
    // Default fallback
    switchState('landing');
  }

  // Hide non-active states immediately on load without transition
  Object.values(states).forEach(el => {
    el.style.display = 'none';
    el.classList.remove('active');
  });
  
  init();
});