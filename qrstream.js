// QRStream Protocol Implementation

// QR Capacity Table in Byte Mode for Versions 1-40 [Level L, Level M, Level Q, Level H]
const QR_CAPACITIES = {
  1:  [17,   14,   11,   7],
  2:  [32,   26,   20,   14],
  3:  [53,   42,   32,   24],
  4:  [78,   62,   46,   34],
  5:  [106,  84,   60,   44],
  6:  [134,  106,  74,   58],
  7:  [154,  122,  86,   64],
  8:  [192,  152,  108,  84],
  9:  [230,  180,  130,  98],
  10: [271,  213,  151,  119],
  11: [321,  251,  177,  137],
  12: [367,  287,  203,  155],
  13: [425,  331,  241,  177],
  14: [458,  362,  258,  194],
  15: [520,  412,  292,  220],
  16: [586,  450,  322,  250],
  17: [644,  504,  364,  280],
  18: [718,  560,  394,  310],
  19: [792,  624,  442,  338],
  20: [858,  666,  482,  382],
  21: [929,  711,  509,  403],
  22: [1003, 779,  565,  439],
  23: [1091, 860,  611,  462],
  24: [1171, 914,  661,  511],
  25: [1273, 1000, 715,  535],
  26: [1367, 1062, 782,  593],
  27: [1465, 1128, 862,  625],
  28: [1528, 1193, 908,  658],
  29: [1628, 1267, 973,  698],
  30: [1732, 1373, 1037, 742],
  31: [1840, 1455, 1085, 790],
  32: [1952, 1541, 1156, 842],
  33: [2068, 1631, 1230, 898],
  34: [2188, 1725, 1308, 958],
  35: [2303, 1812, 1388, 1022],
  36: [2431, 1914, 1468, 1085],
  37: [2563, 1992, 1532, 1156],
  38: [2699, 2102, 1612, 1224],
  39: [2813, 2210, 1704, 1292],
  40: [2953, 2331, 1819, 1370]
};

const ECC_INDEX = { 'L': 0, 'M': 1, 'Q': 2, 'H': 3 };

// State Variables
let selectedFile = null;
let selectedFileData = null;
let senderPreRenderedQRs = []; // Array of offscreen canvas elements
let senderLoopInterval = null;
let senderScanTimeout = null;
let senderScanActive = false;
let receiverScanActive = false;
let activeSessionId = null;
let senderHandshakeRatio = 1.0; // Pacing adjustment ratio from handshake
let receiverN = 1;
let receiverTotalDataFrames = 0;
let receiverFileSize = 0;
let receiverFilename = "";
let receiverFrames = new Map(); // frameIndex -> Uint8Array payload
let receiverLastScanTime = null;
let receiverInactivityInterval = null;
let currentActiveVideo = null;

// Shared scanning canvas to prevent DOM garbage collection overhead in animation loop
const scanCanvas = document.createElement('canvas');
const scanCtx = scanCanvas.getContext('2d');

// DOM Event Bindings
document.addEventListener('DOMContentLoaded', () => {
  // Initial Config Preview
  updateConfigPreview();

  // Settings Events
  document.getElementById('setting-version').addEventListener('input', () => {
    document.getElementById('val-version').textContent = document.getElementById('setting-version').value;
    updateConfigPreview();
  });
  document.getElementById('setting-ecc').addEventListener('change', () => {
    updateConfigPreview();
  });
  document.getElementById('setting-hz').addEventListener('input', () => {
    const val = document.getElementById('setting-hz').value;
    document.getElementById('val-hz').textContent = `${val} Hz`;
    document.getElementById('send-setting-hz').value = val;
    document.getElementById('send-val-hz').textContent = `${val} Hz`;
    updateConfigPreview();
  });

  document.getElementById('send-setting-hz').addEventListener('input', () => {
    const val = document.getElementById('send-setting-hz').value;
    document.getElementById('setting-hz').value = val;
    document.getElementById('val-hz').textContent = `${val} Hz`;
    updateConfigPreview();
    if (senderHandshakeRatio < 1.0) {
      const activeHz = val * senderHandshakeRatio;
      document.getElementById('send-val-hz').textContent = `${val} Hz (Active: ${activeHz.toFixed(1)} Hz)`;
    } else {
      document.getElementById('send-val-hz').textContent = `${val} Hz`;
    }
  });

  // Navigation Click Handlers
  document.getElementById('btn-show-send').addEventListener('click', () => {
    showView('send-screen');
    resetSenderUI();
  });

  document.getElementById('btn-show-receive').addEventListener('click', () => {
    showView('receive-screen');
    resetReceiverUI();
    startReceiverWorkflow();
  });

  document.querySelectorAll('.btn-back').forEach(btn => {
    btn.addEventListener('click', () => {
      cleanupMedia();
      showView('main-screen');
    });
  });

  document.getElementById('btn-success-done').addEventListener('click', () => {
    document.getElementById('success-screen').classList.remove('active');
    showView('main-screen');
  });

  // File Drop Zone handlers
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  dropZone.addEventListener('click', () => fileInput.click());
  
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--color-primary)';
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.style.borderColor = 'var(--border-color)';
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--border-color)';
    if (e.dataTransfer.files.length > 0) {
      handleFileSelection(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      handleFileSelection(fileInput.files[0]);
    }
  });

  // Sender Actions
  document.getElementById('btn-start-sprint').addEventListener('click', startSenderSprintWorkflow);
  document.getElementById('btn-cancel-send').addEventListener('click', cancelSenderWorkflow);
  document.getElementById('btn-cancel-scan').addEventListener('click', cancelSenderWorkflow);

  // Receiver Actions
  document.getElementById('btn-cancel-receive').addEventListener('click', cancelReceiverWorkflow);
});

// View Navigation Manager
function showView(viewId) {
  const views = ['main-screen', 'send-screen', 'receive-screen'];
  views.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (id === viewId) el.classList.add('active');
      else el.classList.remove('active');
    }
  });
}

// UI Reset Helpers
function resetSenderUI() {
  cleanupMedia();
  selectedFile = null;
  selectedFileData = null;
  senderPreRenderedQRs = [];
  senderHandshakeRatio = 1.0;
  
  const fileInput = document.getElementById('file-input');
  if (fileInput) fileInput.value = "";
  
  document.getElementById('send-init-view').classList.remove('hidden');
  document.getElementById('send-active-view').classList.add('hidden');
  document.getElementById('send-scan-view').classList.add('hidden');
  document.getElementById('file-info').classList.add('hidden');
}

function resetReceiverUI() {
  cleanupMedia();
  resetReceiverSessionState();
  
  document.getElementById('receive-active-view').classList.remove('hidden');
  document.getElementById('report-card-container').classList.add('hidden');
  document.getElementById('receive-status-label').textContent = 'Waiting for camera...';
  
  const receiveVideoWrapper = document.getElementById('receive-video-wrapper');
  if (receiveVideoWrapper) {
    receiveVideoWrapper.classList.remove('thumbnail');
    receiveVideoWrapper.classList.remove('hidden');
  }
  
  // Clear receive progress canvas
  const canvas = document.getElementById('receive-progress-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// Media Cleanup (Stops camera and streaming timers)
function cleanupMedia() {
  stopSenderTransmission();
  receiverScanActive = false;
  senderScanActive = false;
  
  if (receiverInactivityInterval) {
    clearInterval(receiverInactivityInterval);
    receiverInactivityInterval = null;
  }

  stopCamera(document.getElementById('send-video'));
  stopCamera(document.getElementById('receive-video'));
}

function stopCamera(videoEl) {
  if (videoEl && videoEl.srcObject) {
    const stream = videoEl.srcObject;
    const tracks = stream.getTracks();
    tracks.forEach(track => track.stop());
    videoEl.srcObject = null;
  }
}

function stopSenderTransmission() {
  if (senderLoopInterval) {
    clearInterval(senderLoopInterval);
    senderLoopInterval = null;
  }
  if (senderScanTimeout) {
    clearTimeout(senderScanTimeout);
    senderScanTimeout = null;
  }
  senderScanActive = false;
}

// File Processing
function handleFileSelection(file) {
  selectedFile = file;
  const reader = new FileReader();
  reader.onload = async (e) => {
    selectedFileData = new Uint8Array(e.target.result);
    await initializeSenderUploadWorkflow();
  };
  reader.readAsArrayBuffer(file);
}

// Dynamic N-byte Frame Parameters Calculator
function calculateSessionParams(fileSize, version, eccLevel) {
  const capacity = QR_CAPACITIES[version][ECC_INDEX[eccLevel]];
  const safetyMargin = 4; // safety margin for QR code structural overhead
  let N = 1;
  let payloadSize = 0;
  let totalDataFrames = 0;
  
  while (N <= 8) {
    payloadSize = capacity - N - safetyMargin;
    if (payloadSize <= 0) {
      throw new Error(`QR size Version ${version} with ECC ${eccLevel} is too small to fit header metadata.`);
    }
    totalDataFrames = Math.ceil(fileSize / payloadSize);
    const maxIndexVal = Math.pow(2, 8 * N) - 1;
    if (totalDataFrames <= maxIndexVal) {
      break;
    }
    N++;
  }
  return {
    capacity,
    N,
    payloadSize,
    totalDataFrames
  };
}

function updateConfigPreview() {
  const version = parseInt(document.getElementById('setting-version').value);
  const ecc = document.getElementById('setting-ecc').value;
  const hz = parseInt(document.getElementById('setting-hz').value);
  
  try {
    const params = calculateSessionParams(15000, version, ecc);
    document.getElementById('val-version').textContent = version;
    document.getElementById('val-hz').textContent = `${hz} Hz`;
    document.getElementById('val-capacity').textContent = params.capacity;
    document.getElementById('val-payload').textContent = params.payloadSize;
    
    const speedBytes = params.payloadSize * hz;
    const speedKB = (speedBytes / 1024).toFixed(2);
    document.getElementById('val-speed').textContent = speedKB;
  } catch (err) {
    document.getElementById('val-capacity').textContent = '--';
    document.getElementById('val-payload').textContent = '--';
    document.getElementById('val-speed').textContent = '--';
  }
}

// Sender Workflows
async function initializeSenderUploadWorkflow() {
  if (!selectedFileData || !selectedFile) return;

  const version = parseInt(document.getElementById('setting-version').value);
  const ecc = document.getElementById('setting-ecc').value;

  let params;
  try {
    params = calculateSessionParams(selectedFileData.length, version, ecc);
  } catch (err) {
    alert(err.message);
    resetSenderUI();
    return;
  }

  // Transition UI instantly to active view
  document.getElementById('send-init-view').classList.add('hidden');
  document.getElementById('send-active-view').classList.remove('hidden');
  document.getElementById('send-status-label').textContent = 'Pre-encoding QR frames...';

  // Populate file details
  document.getElementById('send-info-name').textContent = selectedFile.name;
  document.getElementById('send-info-size').textContent = `${(selectedFile.size / 1024).toFixed(2)} KB`;
  document.getElementById('send-info-frames').textContent = `${params.totalDataFrames} data frames (+1 metadata frame)`;

  // Pre-render QR codes
  try {
    await preRenderQRCodes(params, version, ecc);
  } catch (err) {
    alert(`Encoding failed: ${err.message}`);
    resetSenderUI();
    return;
  }

  // Draw Frame 0 immediately
  drawPreRenderedQR(0);

  // Ready for alignment
  document.getElementById('send-status-label').textContent = 'Align screens. Tap Start to transmit.';
  document.getElementById('send-progress-text').textContent = `Frame 0 of ${params.totalDataFrames}`;
  document.getElementById('send-progress-percent').textContent = 'Ready';
  document.getElementById('send-progress-bar').style.width = '0%';

  // Initialize live slider value and text badge
  const initialHz = document.getElementById('setting-hz').value;
  document.getElementById('send-setting-hz').value = initialHz;
  document.getElementById('send-val-hz').textContent = `${initialHz} Hz`;

  // Reset Start button state
  const startBtn = document.getElementById('btn-start-sprint');
  if (startBtn) {
    startBtn.disabled = false;
    startBtn.style.display = 'inline-flex';
  }
}

function startSenderSprintWorkflow() {
  const startBtn = document.getElementById('btn-start-sprint');
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.style.display = 'none';
  }

  const version = parseInt(document.getElementById('setting-version').value);
  const ecc = document.getElementById('setting-ecc').value;
  const hz = parseInt(document.getElementById('setting-hz').value);

  const params = calculateSessionParams(selectedFileData.length, version, ecc);

  document.getElementById('send-status-label').textContent = 'Phase 1: Starting in 0.5s...';

  setTimeout(() => {
    document.getElementById('send-status-label').textContent = 'Phase 1: Sprint Transmitting...';
    let currentFrameIdx = 1;

    function runSprintTick() {
      if (currentFrameIdx <= params.totalDataFrames) {
        drawPreRenderedQR(currentFrameIdx);
        
        // Progress
        const pct = Math.round((currentFrameIdx / params.totalDataFrames) * 100);
        document.getElementById('send-progress-text').textContent = `Frame ${currentFrameIdx} of ${params.totalDataFrames}`;
        document.getElementById('send-progress-percent').textContent = `${pct}%`;
        document.getElementById('send-progress-bar').style.width = `${pct}%`;
        
        currentFrameIdx++;

        // Get live Hz value from the slider
        const liveHz = parseInt(document.getElementById('send-setting-hz').value);
        const intervalMs = 1000 / liveHz;
        senderLoopInterval = setTimeout(runSprintTick, intervalMs);
      } else {
        // Finished the Sprint
        senderLoopInterval = null;
        
        // Step 4: The Switch
        initiateSenderReportCardScan(params);
      }
    }

    // Schedule first tick
    const liveHz = parseInt(document.getElementById('send-setting-hz').value);
    senderLoopInterval = setTimeout(runSprintTick, 1000 / liveHz);

  }, 500); // Hardcoded 0.5s delay
}

function cancelSenderWorkflow() {
  stopSenderTransmission();
  resetSenderUI();
}

// Pre-renderer for Sender QR Frames
async function preRenderQRCodes(params, version, ecc) {
  senderPreRenderedQRs = [];
  const sessionId = Math.floor(Math.random() * 256);
  activeSessionId = sessionId;

  // Generate Frame 0 (Metadata Frame)
  const encoder = new TextEncoder();
  const filenameBytes = encoder.encode(selectedFile.name);
  const frame0PayloadSize = 11 + filenameBytes.length;
  const frame0Buffer = new Uint8Array(frame0PayloadSize);
  frame0Buffer[0] = 0x00; // Frame 0 indicator
  frame0Buffer[1] = params.N;
  frame0Buffer[2] = sessionId;
  
  // Total data frames (uint32, big-endian)
  frame0Buffer[3] = (params.totalDataFrames >> 24) & 0xFF;
  frame0Buffer[4] = (params.totalDataFrames >> 16) & 0xFF;
  frame0Buffer[5] = (params.totalDataFrames >> 8) & 0xFF;
  frame0Buffer[6] = params.totalDataFrames & 0xFF;
  
  // File size (uint32, big-endian)
  frame0Buffer[7] = (selectedFileData.length >> 24) & 0xFF;
  frame0Buffer[8] = (selectedFileData.length >> 16) & 0xFF;
  frame0Buffer[9] = (selectedFileData.length >> 8) & 0xFF;
  frame0Buffer[10] = selectedFileData.length & 0xFF;
  
  frame0Buffer.set(filenameBytes, 11);
  
  // Create Frame 0 Canvas
  senderPreRenderedQRs.push(await renderQRToOffscreenCanvas(frame0Buffer, version, ecc));

  // Chunk file data and create Frame 1..M Canvases
  for (let i = 1; i <= params.totalDataFrames; i++) {
    const start = (i - 1) * params.payloadSize;
    const end = Math.min(start + params.payloadSize, selectedFileData.length);
    const chunk = selectedFileData.subarray(start, end);
    
    const dataBuffer = new Uint8Array(params.N + chunk.length);
    
    // Write N-byte frame index in big-endian
    let tempIdx = i;
    for (let byteIdx = params.N - 1; byteIdx >= 0; byteIdx--) {
      dataBuffer[byteIdx] = tempIdx & 0xFF;
      tempIdx = tempIdx >> 8;
    }
    dataBuffer.set(chunk, params.N);
    
    senderPreRenderedQRs.push(await renderQRToOffscreenCanvas(dataBuffer, version, ecc));
  }
}

// Generate Canvas element for binary data
function renderQRToOffscreenCanvas(uint8Array, version, ecc) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    QRCode.toCanvas(canvas, [
      { data: uint8Array, mode: 'byte' }
    ], {
      version: version,
      errorCorrectionLevel: ecc,
      margin: 2,
      width: 400
    }, (err) => {
      if (err) reject(err);
      else resolve(canvas);
    });
  });
}

function drawPreRenderedQR(frameIdx) {
  const displayCanvas = document.getElementById('send-qr-canvas');
  const offscreenCanvas = senderPreRenderedQRs[frameIdx];
  if (!displayCanvas || !offscreenCanvas) return;
  
  displayCanvas.width = offscreenCanvas.width;
  displayCanvas.height = offscreenCanvas.height;
  const ctx = displayCanvas.getContext('2d');
  ctx.drawImage(offscreenCanvas, 0, 0);
}

// Phase 2: Sender Scanning for Report Card
async function initiateSenderReportCardScan(params) {
  document.getElementById('send-active-view').classList.add('hidden');
  document.getElementById('send-scan-view').classList.remove('hidden');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }
    });
    
    // Attempt continuous autofocus constraint safely
    const track = stream.getVideoTracks()[0];
    if (track && typeof track.applyConstraints === 'function') {
      try {
        await track.applyConstraints({
          advanced: [{ focusMode: 'continuous' }]
        });
      } catch (e) {
        console.warn('Continuous focus constraint not supported:', e);
      }
    }

    const sendVideo = document.getElementById('send-video');
    sendVideo.srcObject = stream;
    currentActiveVideo = sendVideo;
    senderScanActive = true;
    
    // Start scanning report card
    requestAnimationFrame(processSenderReportCardFrame);

    // 20-second timeout window
    let timeLeft = 20;
    const sendTimer = document.getElementById('send-timer');
    sendTimer.textContent = `${timeLeft}s remaining`;
    
    senderScanTimeout = setInterval(() => {
      timeLeft--;
      sendTimer.textContent = `${timeLeft}s remaining`;
      
      if (timeLeft <= 0) {
        clearInterval(senderScanTimeout);
        senderScanTimeout = null;
        alert('Timeout: No Report Card QR code detected.');
        stopSenderTransmission();
        document.getElementById('btn-cancel-scan').click();
      }
    }, 1000);

  } catch (err) {
    alert(`Camera error on Sender: ${err.message}`);
    document.getElementById('btn-cancel-scan').click();
  }
}

// Parse frames on Sender to look for Report Card QR
function processSenderReportCardFrame() {
  if (!senderScanActive) return;
  
  const video = document.getElementById('send-video');
  if (video.readyState >= video.HAVE_CURRENT_DATA) {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      // Downscale frame for jsQR performance (max 480px)
      const maxDim = 480;
      let targetW = video.videoWidth;
      let targetH = video.videoHeight;
      if (targetW > maxDim || targetH > maxDim) {
        const aspect = targetW / targetH;
        if (targetW > targetH) {
          targetW = maxDim;
          targetH = Math.round(maxDim / aspect);
        } else {
          targetH = maxDim;
          targetW = Math.round(maxDim * aspect);
        }
      }

      if (scanCanvas.width !== targetW || scanCanvas.height !== targetH) {
        scanCanvas.width = targetW;
        scanCanvas.height = targetH;
      }
      scanCtx.drawImage(video, 0, 0, targetW, targetH);
      
      const imageData = scanCtx.getImageData(0, 0, targetW, targetH);
      const code = jsQR(imageData.data, targetW, targetH, {
        inversionAttempts: "attemptBoth"
      });
      
      if (code) {
        console.log("Sender scanned QR (Report Card):", code.data || "[Binary]", code.binaryData);
        if (code.binaryData && code.binaryData.length >= 2) {
          // Decode Report Card
          const scannedBytes = new Uint8Array(code.binaryData);
          const scannedSessionId = scannedBytes[0];
          const scannedTotalFrames = scannedBytes[1];
          
          // Verify Session compatibility
          if (scannedSessionId === activeSessionId && scannedTotalFrames === senderPreRenderedQRs.length - 1) { // Total data frames count
            // Stop scanning
            senderScanActive = false;
            if (senderScanTimeout) {
              clearInterval(senderScanTimeout);
              senderScanTimeout = null;
            }
            stopCamera(video);
            
            // Parse missing frames from bitfield
            const missingIndices = [];
            const bitfield = scannedBytes.slice(2);
            const totalFramesCount = senderPreRenderedQRs.length; // Metadata frame 0 + data frames 1..M
            
            for (let i = 0; i < totalFramesCount; i++) {
              const byteIdx = Math.floor(i / 8);
              const bitIdx = i % 8;
              const received = (bitfield[byteIdx] & (1 << bitIdx)) !== 0;
              if (!received) {
                missingIndices.push(i);
              }
            }
            
            if (missingIndices.length === 0) {
              // All frames successfully transferred
              showSuccessScreen();
            } else {
              const totalDataFrames = senderPreRenderedQRs.length - 1;
              const missingDataFrames = missingIndices.filter(idx => idx > 0).length;
              const transferRate = (totalDataFrames - missingDataFrames) / totalDataFrames;
              senderHandshakeRatio = Math.max(0.1, 0.1 + (transferRate - 0.1) / 0.9);
              console.log(`Handshake complete. Transfer rate: ${(transferRate * 100).toFixed(1)}%. Handshake ratio: ${senderHandshakeRatio.toFixed(3)}`);
              
              // Launch Phase 2 Targeted Loop
              startSenderTargetedLoop(missingIndices);
            }
            return;
          }
        }
      }
    }
  }
  
  requestAnimationFrame(processSenderReportCardFrame);
}

// Flashes only the missing frames in an infinite loop
function startSenderTargetedLoop(missingIndices) {
  document.getElementById('send-scan-view').classList.add('hidden');
  document.getElementById('send-active-view').classList.remove('hidden');
  document.getElementById('send-status-label').textContent = `Phase 2: Flashing ${missingIndices.length} missing frames in loop...`;

  let loopIdx = 0;

  function runTargetedLoopTick() {
    const frameToFlash = missingIndices[loopIdx];
    drawPreRenderedQR(frameToFlash);
    
    document.getElementById('send-progress-text').textContent = `Flashing missing frame ${frameToFlash} (${loopIdx + 1}/${missingIndices.length})`;
    document.getElementById('send-progress-percent').textContent = 'Looping';
    document.getElementById('send-progress-bar').style.width = '100%';
    
    // Read live base Hz from the slider
    const baseHz = parseInt(document.getElementById('send-setting-hz').value);
    const activeHz = baseHz * senderHandshakeRatio;
    
    // Update live text badge to show the active frequency
    document.getElementById('send-val-hz').textContent = `${baseHz} Hz (Active: ${activeHz.toFixed(1)} Hz)`;
    
    loopIdx = (loopIdx + 1) % missingIndices.length;
    
    const intervalMs = 1000 / activeHz;
    senderLoopInterval = setTimeout(runTargetedLoopTick, intervalMs);
  }

  // Schedule first tick
  const baseHz = parseInt(document.getElementById('send-setting-hz').value);
  const activeHz = baseHz * senderHandshakeRatio;
  document.getElementById('send-val-hz').textContent = `${baseHz} Hz (Active: ${activeHz.toFixed(1)} Hz)`;
  
  senderLoopInterval = setTimeout(runTargetedLoopTick, 1000 / activeHz);
}

function showSuccessScreen() {
  stopSenderTransmission();
  const successScreen = document.getElementById('success-screen');
  const successFilename = document.getElementById('success-filename');
  const successFilesize = document.getElementById('success-filesize');
  
  successFilename.textContent = selectedFile ? selectedFile.name : receiverFilename;
  successFilesize.textContent = selectedFile ? `${(selectedFile.size / 1024).toFixed(2)} KB` : `${(receiverFileSize / 1024).toFixed(2)} KB`;
  successScreen.classList.add('active');
}

// Receiver Workflows
async function startReceiverWorkflow() {
  document.getElementById('receive-init-view').classList.add('hidden');
  document.getElementById('receive-active-view').classList.remove('hidden');
  document.getElementById('receive-status-label').textContent = 'Requesting camera access...';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }
    });
    
    // Attempt continuous autofocus constraint safely
    const track = stream.getVideoTracks()[0];
    if (track && typeof track.applyConstraints === 'function') {
      try {
        await track.applyConstraints({
          advanced: [{ focusMode: 'continuous' }]
        });
      } catch (e) {
        console.warn('Continuous focus constraint not supported:', e);
      }
    }

    const receiveVideo = document.getElementById('receive-video');
    receiveVideo.srcObject = stream;
    currentActiveVideo = receiveVideo;
    
    document.getElementById('receive-status-label').textContent = 'Align screen. Waiting for metadata frame...';
    receiverScanActive = true;
    resetReceiverSessionState();
    
    // Start processing frames
    requestAnimationFrame(processReceiverFrame);
  } catch (err) {
    alert(`Camera error: ${err.message}`);
    resetReceiverUI();
  }
}

function cancelReceiverWorkflow() {
  cleanupMedia();
  resetReceiverUI();
}

function resetReceiverSessionState() {
  activeSessionId = null;
  receiverN = 1;
  receiverTotalDataFrames = 0;
  receiverFileSize = 0;
  receiverFilename = "";
  receiverFrames.clear();
  receiverLastScanTime = null;
  
  if (receiverInactivityInterval) {
    clearInterval(receiverInactivityInterval);
  }
  
  receiverInactivityInterval = setInterval(checkReceiverInactivity, 500);
}

function processReceiverFrame() {
  if (!receiverScanActive) return;
  
  const video = document.getElementById('receive-video');
  if (video.readyState >= video.HAVE_CURRENT_DATA) {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      // Downscale frame for jsQR performance (max 480px)
      const maxDim = 480;
      let targetW = video.videoWidth;
      let targetH = video.videoHeight;
      if (targetW > maxDim || targetH > maxDim) {
        const aspect = targetW / targetH;
        if (targetW > targetH) {
          targetW = maxDim;
          targetH = Math.round(maxDim / aspect);
        } else {
          targetH = maxDim;
          targetW = Math.round(maxDim * aspect);
        }
      }

      if (scanCanvas.width !== targetW || scanCanvas.height !== targetH) {
        scanCanvas.width = targetW;
        scanCanvas.height = targetH;
      }
      scanCtx.drawImage(video, 0, 0, targetW, targetH);
      
      const imageData = scanCtx.getImageData(0, 0, targetW, targetH);
      const code = jsQR(imageData.data, targetW, targetH, {
        inversionAttempts: "attemptBoth"
      });
      
      if (code) {
        console.log("Receiver scanned QR:", code.data || "[Binary]", code.binaryData);
        if (code.binaryData && code.binaryData.length >= 4) {
          handleScannedReceiverData(new Uint8Array(code.binaryData));
        }
      }
    }
  }
  
  requestAnimationFrame(processReceiverFrame);
}

function handleScannedReceiverData(binaryData) {
  const firstByte = binaryData[0];
  
  if (activeSessionId === null) {
    // Phase 1 Start: Expecting Metadata Frame (firstByte must be 0x00)
    if (firstByte === 0x00 && binaryData.length >= 11) {
      receiverN = binaryData[1];
      activeSessionId = binaryData[2];
      receiverTotalDataFrames = (binaryData[3] << 24) | (binaryData[4] << 16) | (binaryData[5] << 8) | binaryData[6];
      receiverFileSize = (binaryData[7] << 24) | (binaryData[8] << 16) | (binaryData[9] << 8) | binaryData[10];
      receiverFilename = new TextDecoder().decode(binaryData.slice(11));
      
      // Save metadata frame
      receiverFrames.set(0, binaryData.slice(11));
      receiverLastScanTime = Date.now();
      
      document.getElementById('receive-status-label').textContent = 'Metadata loaded! Tell the Sender to tap Start.';
      updateReceiverProgressUI();
    }
  } else {
    // Session Active: Expecting Frame 0 or Data Frames
    receiverLastScanTime = Date.now();
    
    if (firstByte === 0x00) {
      // Re-read Frame 0 just in case
      return;
    }
    
    // Parse Data Frame index (N-byte header)
    if (binaryData.length >= receiverN) {
      let frameIndex = 0;
      for (let i = 0; i < receiverN; i++) {
        frameIndex = (frameIndex << 8) | binaryData[i];
      }
      
      if (frameIndex >= 1 && frameIndex <= receiverTotalDataFrames) {
        if (!receiverFrames.has(frameIndex)) {
          const payload = binaryData.slice(receiverN);
          receiverFrames.set(frameIndex, payload);
          updateReceiverProgressUI();
          
          // Check if gaps are filled (100% complete)
          if (receiverFrames.size === receiverTotalDataFrames + 1) {
            finalizeReceiverTransfer();
          }
        }
      }
    }
  }
}

function checkReceiverInactivity() {
  if (!receiverScanActive || activeSessionId === null || receiverLastScanTime === null) return;
  
  const timeSinceLastScan = Date.now() - receiverLastScanTime;
  const timeoutThreshold = 2000; // 2 seconds inactivity implies transmission phase ended
  
  if (timeSinceLastScan > timeoutThreshold) {
    // Transmission gap detected!
    if (receiverFrames.size === receiverTotalDataFrames + 1) {
      finalizeReceiverTransfer();
    } else {
      // Missing data -> Trigger Report Card
      generateReceiverReportCard();
    }
  }
}

function updateReceiverProgressUI() {
  if (activeSessionId === null) return;
  
  const totalFrames = receiverTotalDataFrames + 1; // Metadata frame 0 + data frames
  const goodFrames = receiverFrames.size;
  const goodDataFrames = Array.from(receiverFrames.keys()).filter(idx => idx > 0).length;
  
  // Find highest index scanned to compute dropped frames during sequential sprint
  const frameIndices = Array.from(receiverFrames.keys());
  const maxScannedIndex = Math.max(...frameIndices);
  
  let droppedCount = 0;
  for (let i = 1; i <= maxScannedIndex; i++) {
    if (!receiverFrames.has(i)) {
      droppedCount++;
    }
  }
  
  const goodPct = Math.round((goodDataFrames / receiverTotalDataFrames) * 100);
  const droppedPct = Math.round((droppedCount / receiverTotalDataFrames) * 100);
  
  // Update HTML text labels
  document.getElementById('receive-progress-text').textContent = `${goodDataFrames} / ${receiverTotalDataFrames} data frames received`;
  document.getElementById('receive-progress-percent').textContent = `${goodPct}%`;
  
  document.getElementById('val-good-frames').textContent = goodDataFrames;
  document.getElementById('val-dropped-frames').textContent = droppedCount;
  document.getElementById('val-dropped-percent').textContent = `${droppedPct}%`;
  
  // Draw Canvas progress indicator
  drawReceiverProgressBarCanvas(maxScannedIndex);
}

function drawReceiverProgressBarCanvas(maxScannedIndex) {
  const canvas = document.getElementById('receive-progress-canvas');
  const ctx = canvas.getContext('2d');
  
  // Fix resolution matching DOM clientWidth
  canvas.width = canvas.clientWidth;
  
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  
  const cellCount = receiverTotalDataFrames;
  const cellWidth = W / cellCount;
  
  for (let i = 1; i <= cellCount; i++) {
    const xStart = (i - 1) * cellWidth;
    const xEnd = i * cellWidth;
    
    if (receiverFrames.has(i)) {
      ctx.fillStyle = '#10b981'; // Green (Good)
    } else if (i < maxScannedIndex) {
      ctx.fillStyle = '#ef4444'; // Red (Dropped)
    } else {
      ctx.fillStyle = '#e5e7eb'; // Grey (Neutral background)
    }
    
    ctx.fillRect(xStart, 0, cellWidth - 0.5, H);
  }
}

async function generateReceiverReportCard() {
  // Stop scanning camera temporarily to save cpu and let user scan easily
  receiverScanActive = false;
  
  document.getElementById('receive-status-label').textContent = 'Phase 2: Handshake (Displaying Report Card)';
  
  const receiveVideoWrapper = document.getElementById('receive-video-wrapper');
  if (receiveVideoWrapper) {
    receiveVideoWrapper.classList.add('thumbnail');
  }
  
  // Generate Bitfield representing received packets
  const totalFramesCount = receiverTotalDataFrames + 1; // Metadata frame 0 + data frames 1..M
  const bitfieldSize = Math.ceil(totalFramesCount / 8);
  const reportData = new Uint8Array(2 + bitfieldSize);
  
  reportData[0] = activeSessionId;
  reportData[1] = receiverTotalDataFrames; // Total data frames count
  
  for (let i = 0; i < totalFramesCount; i++) {
    if (receiverFrames.has(i)) {
      const byteIdx = 2 + Math.floor(i / 8);
      const bitIdx = i % 8;
      reportData[byteIdx] |= (1 << bitIdx);
    }
  }
  
  // Render report card to canvas
  try {
    const reportCardCanvas = document.getElementById('report-card-canvas');
    await new Promise((resolve, reject) => {
      QRCode.toCanvas(reportCardCanvas, [
        { data: reportData, mode: 'byte' }
      ], {
        version: 2, // Force version 2 which easily fits up to 32 bytes bitfield
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 300
      }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    // Show report card
    document.getElementById('report-card-container').classList.remove('hidden');
    
    // Resume camera scanning for Phase 2 missing frames
    receiverScanActive = true;
    requestAnimationFrame(processReceiverFrame);
  } catch (err) {
    alert(`Failed to generate Report Card QR: ${err.message}`);
    // If QR failed, fall back to starting scan anyway
    receiverScanActive = true;
    requestAnimationFrame(processReceiverFrame);
  }
}

function finalizeReceiverTransfer() {
  receiverScanActive = false;
  if (receiverInactivityInterval) {
    clearInterval(receiverInactivityInterval);
    receiverInactivityInterval = null;
  }
  
  // Stop video stream
  stopCamera(document.getElementById('receive-video'));
  
  // Re-assemble file payloads
  const fileData = new Uint8Array(receiverFileSize);
  let offset = 0;
  
  for (let i = 1; i <= receiverTotalDataFrames; i++) {
    const payload = receiverFrames.get(i);
    if (payload) {
      const copyLen = Math.min(payload.length, receiverFileSize - offset);
      if (copyLen > 0) {
        fileData.set(payload.subarray(0, copyLen), offset);
        offset += copyLen;
      }
    }
  }
  
  // Generate download trigger
  const blob = new Blob([fileData], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = receiverFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  // Render success overlay screen
  showSuccessScreen();
  resetReceiverUI();
}
