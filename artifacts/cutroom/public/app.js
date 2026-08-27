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
    presetChips: document.querySelectorAll('.preset-chip'),
    btnSendBrief: document.getElementById('btn-send-brief'),
    briefError: document.getElementById('brief-error'),
    logText: document.querySelector('.log-text')
  };

  // --- Constants ---
  const MAX_FILES = 10;
  const MAX_SIZE_MB = 200;
  const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
  const VALID_TYPES = ['video/mp4', 'video/quicktime'];

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
        throw new Error(data.error || 'Failed to prepare sample footage.');
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
      elements.uploadError.textContent = `Maximum ${MAX_FILES} files allowed.`;
      elements.fileInput.value = '';
      return;
    }

    let totalSize = 0;
    const formData = new FormData();
    formData.append('sessionId', sessionId);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isMacMP4 = file.name.toLowerCase().endsWith('.mp4');
      const isMacMOV = file.name.toLowerCase().endsWith('.mov');
      
      if (!VALID_TYPES.includes(file.type) && !isMacMP4 && !isMacMOV) {
        elements.uploadError.textContent = 'Only .mp4 or .mov files are accepted.';
        elements.fileInput.value = '';
        return;
      }
      totalSize += file.size;
      formData.append('clips', file);
    }

    if (totalSize > MAX_SIZE_BYTES) {
      elements.uploadError.textContent = `Total file size exceeds ${MAX_SIZE_MB}MB limit.`;
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
        throw new Error(data.error || 'Upload failed. Please try again.');
      }
      
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
    if (!brief && !selectedPreset) {
      elements.briefError.textContent = 'Tell the crew what you want, or choose a preset.';
      return;
    }

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
          
          if (data.log && data.status !== 'completed') {
             elements.logText.textContent = data.log;
          }
          
          if (data.status === 'completed') {
            clearInterval(pollInterval);
            elements.logText.textContent = 'Assembly complete. Your rough cut is ready.';
            elements.logText.classList.remove('blink');
          } else if (data.status === 'error') {
            clearInterval(pollInterval);
            elements.logText.textContent = 'Error during assembly: ' + (data.error || 'Unknown error');
            elements.logText.classList.remove('blink');
            elements.logText.style.color = 'var(--error)';
          }
        }
      } catch (err) {
        // Silently fail polling to avoid interrupting the visual experience
      }
    }, 2000);
  }

  // --- Initialization ---
  async function init() {
    try {
      const res = await fetch(`/api/session?sessionId=${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        sessionId = data.sessionId || data.id || sessionId;
        sessionStorage.setItem('cutroom_session_id', sessionId);
        if (data.status === 'assembling') {
          switchState('assembly');
          startStatusPolling();
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