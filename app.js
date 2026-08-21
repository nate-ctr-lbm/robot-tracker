let entries = [];
  // nextId removed — entries now use Supabase-generated UUIDs; ordering uses nextSeq instead.
  let currentTaskNumber = 1;
  let taskInProgress = false;
  let taskStartTimestamp = null;
  let currentTaskDescription = '';
  let pausedTaskElapsed = null;
  let downtimeInProgress = false;
  let downtimeStartTimestamp = null;
  let pausedDowntimeElapsed = null;
  let lunchInProgress = false;
  let lunchStartTimestamp = null;
  let pausedLunchElapsed = null;
  let deadTimeInProgress = false;
  let deadTimeStartTimestamp = null;
  let currentDowntimeCategory = '';
  let viewingDate = null; // set on init to today's date string
  let followingToday = true; // true = auto-track today; false = pinned to a specific past/future date
  let currentOperator = 'Ajar';
  let mainSessionType = '';
  let idleThresholdMinutes = 5;
  let lastActivityTime = new Date();
  let autoDowntimeActive = false;

  const PREFS_KEY = 'walden_robot_use_tracker_prefs_v1';

  // ---- Supabase config ----
  // The URL and publishable key below are safe to be public — this is how
  // Supabase is designed to work. Real protection comes from the Row Level
  // Security policies set up on the `entries` table in the Supabase project,
  // not from hiding these values.
  const SUPABASE_URL = 'https://wwzoubxdgsgtopxrqbin.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3em91YnhkZ3NndG9weHJxYmluIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzOTAxMTQsImV4cCI6MjEwMTk2NjExNH0.84_9fVkGjSfV2FJKZ2D7AtKVdpa2UOrzKg9TTqfzpuM';
  // One shared login for the whole team — not a real personal account.
  // Whoever set this up in Supabase's Authentication tab picked this email;
  // the actual secret is the password, entered as the "passcode" below.
  const SHARED_LOGIN_EMAIL = 'team@robot-tracker.local';
  let supabaseClient = null;
  let nextSeq = 1; // local-only ordering tiebreaker, separate from Supabase's UUID id
  const pendingDeleteKeys = new Set(); // handles deleting an entry before its insert resolves

  function entryContentKey(e) {
    return `${e.date}|${e.timestamp}|${e.type}|${e.note}|${e.operator || ''}`;
  }

  // ---- Google Drive archive (via Apps Script Web App) ----
  // Currently disabled: the deployed Apps Script is being blocked by CORS
  // from this account's domain-restricted deployment. Flip this to true
  // once that's resolved (e.g. redeployed under a personal Google account).
  const DRIVE_UPLOAD_ENABLED = false;
  const DRIVE_UPLOAD_URL = 'https://script.google.com/a/macros/lbm.global/s/AKfycbyi-vw6wODrtDRxdU8DT8jI5qqMEfJy64OqoUW_dcbCRGfIRW93DcPcVpgxMUgSVIVq/exec';
  const DRIVE_UPLOAD_SECRET = 'walden-rt-SfDfu2Ag0baAX2Cz';

  function uploadToDrive(filename, content, mimeType) {
    if (!DRIVE_UPLOAD_ENABLED || !DRIVE_UPLOAD_URL) return;
    fetch(DRIVE_UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids a CORS preflight
      body: JSON.stringify({ secret: DRIVE_UPLOAD_SECRET, filename, content, mimeType })
    })
      .then(res => res.json())
      .then(data => {
        if (data.ok) {
          showStatus(`Saved "${filename}" to shared Drive folder`);
        } else {
          console.warn('Drive upload rejected:', data.error);
          showStatus(`Drive save failed: ${data.error || 'unknown error'}`);
        }
      })
      .catch(err => {
        console.warn('Drive upload failed:', err);
        showStatus('Drive save failed — see browser console for details');
      });
  }

  function rowToEntry(row) {
    return {
      id: row.id,
      seq: nextSeq++,
      date: row.entry_date,
      timestamp: row.entry_time,
      type: row.type,
      operator: row.operator || '',
      category: row.category || null,
      note: row.note || '',
      durationSeconds: (typeof row.duration_seconds === 'number') ? row.duration_seconds : null,
      bookingId: row.booking_id || null
    };
  }

  function entryToRow(entry) {
    return {
      entry_date: entry.date,
      entry_time: entry.timestamp,
      type: entry.type,
      operator: entry.operator || null,
      category: entry.category || null,
      note: entry.note || '',
      duration_seconds: (typeof entry.durationSeconds === 'number') ? entry.durationSeconds : null,
      booking_id: entry.bookingId || null
    };
  }

  function setSyncStatus(text, cls) {
    const el = document.getElementById('syncStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('status-connected', 'status-error');
    if (cls) el.classList.add(cls);
  }

  // Save personal device preferences only (operator, idle threshold) — never
  // the shared log data, which lives in Supabase for everyone.
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        currentOperator: currentOperator,
        idleThresholdMinutes: idleThresholdMinutes
      }));
    } catch (err) { /* ignore — prefs are a nice-to-have, not critical */ }
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      const prefs = JSON.parse(raw);
      currentOperator = prefs.currentOperator || 'Ajar';
      idleThresholdMinutes = (typeof prefs.idleThresholdMinutes === 'number') ? prefs.idleThresholdMinutes : 5;
    } catch (err) { /* ignore */ }
  }

  // Kept for backward-compat naming with the rest of the app's call sites —
  // now just persists personal prefs instead of the shared log.
  function saveToStorage() {
    savePrefs();
  }

  async function initSupabaseSync() {
    if (typeof supabase === 'undefined') {
      setSyncStatus('sync library failed to load', 'status-error');
      return false;
    }
    setSyncStatus('connecting…');

    try {
      const { data, error } = await supabaseClient
        .from('entries')
        .select('*')
        .order('entry_date', { ascending: true })
        .order('entry_time', { ascending: true });

      if (error) throw error;

      entries = (data || []).map(rowToEntry);
      setSyncStatus('live — synced with your team', 'status-connected');
    } catch (err) {
      console.warn('Initial sync fetch failed:', err);
      setSyncStatus('offline — check your connection', 'status-error');
      entries = [];
    }

    // Real-time: any insert/update/delete from any connected browser gets
    // pushed here automatically, keeping everyone's view consistent.
    supabaseClient
      .channel('entries-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'entries' }, handleRealtimeChange)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setSyncStatus('live — synced with your team', 'status-connected');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setSyncStatus('offline — check your connection', 'status-error');
        }
      });

    return entries.length > 0;
  }

  function handleRealtimeChange(payload) {
    if (payload.eventType === 'INSERT') {
      const newRow = payload.new;
      const rowKey = `${newRow.entry_date}|${newRow.entry_time}|${newRow.type}|${newRow.note}|${newRow.operator || ''}`;
      if (pendingDeleteKeys.has(rowKey)) {
        pendingDeleteKeys.delete(rowKey);
        supabaseClient.from('entries').delete().eq('id', newRow.id)
          .then(({ error }) => { if (error) console.warn('Cleanup delete failed:', error); });
        return; // don't add it locally — it was already deleted before this landed
      }
      // Check if this confirms one of OUR OWN optimistic (not-yet-reconciled)
      // entries first, matching by content rather than id — the realtime
      // event can arrive before our own insert's response does.
      const optimisticMatch = entries.find(e =>
        String(e.id).startsWith('local_') &&
        e.date === newRow.entry_date &&
        e.timestamp === newRow.entry_time &&
        e.type === newRow.type &&
        e.note === newRow.note &&
        (e.operator || '') === (newRow.operator || '')
      );
      if (optimisticMatch) {
        optimisticMatch.id = newRow.id; // silently reconcile, no duplicate
      } else {
        const already = entries.some(e => e.id === newRow.id);
        if (!already) entries.push(rowToEntry(newRow));
      }
    } else if (payload.eventType === 'UPDATE') {
      const idx = entries.findIndex(e => e.id === payload.new.id);
      if (idx !== -1) {
        const seq = entries[idx].seq; // preserve local ordering tiebreaker
        entries[idx] = rowToEntry(payload.new);
        entries[idx].seq = seq;
      }
    } else if (payload.eventType === 'DELETE') {
      entries = entries.filter(e => e.id !== payload.old.id);
    }
    inferTaskNumberFromEntries();
    renderLog();
    updateTotals();
  }

  function updateTaskButton() {
    const btn = document.getElementById('taskActionBtn');
    if (taskInProgress) {
      btn.textContent = '⏹ Stop Run';
    } else {
      btn.textContent = '▶ Start Run';
    }
  }

  function resetIdleTimer() {
    // Idle-based auto-downtime detection has been removed — downtime is
    // now fully manual, an operator's own deliberate choice. This function
    // is kept as a harmless no-op since many call sites still reference it.
  }

  function autoCloseDowntime(reason) {
    if (!downtimeInProgress || !downtimeStartTimestamp) return;
    const durationSeconds = Math.round((new Date() - downtimeStartTimestamp) / 1000);
    const category = currentDowntimeCategory || null;
    logEntry('Downtime', `Downtime ended (${formatDuration(durationSeconds)}) — auto-closed: ${reason}`, durationSeconds, category);
    downtimeInProgress = false;
    downtimeStartTimestamp = null;
    autoDowntimeActive = false;
    currentDowntimeCategory = '';
    const categorySelect = document.getElementById('downtimeCategorySelect');
    categorySelect.value = '';
    categorySelect.disabled = false;
    updateDowntimeButton();
    updateTotals();
  }

  let currentTargetMinutes = null;

  function handleTaskAction() {
    if (sessionEnded) {
      showStatus('⚠ Start a Session first');
      return;
    }
    resetIdleTimer();
    // If downtime is currently open and we're about to start a new task,
    // close the downtime first so it doesn't overlap with active work.
    if (!taskInProgress && downtimeInProgress) {
      autoCloseDowntime('task started');
    }

    const noteInput = document.getElementById('noteInput');
    const descInput = document.getElementById('taskDescInput');
    const targetInput = document.getElementById('targetDurationInput');
    const extra = noteInput.value.trim();
    let baseNote, durationSeconds = null;

    if (taskInProgress) {
      baseNote = `Task ${currentTaskNumber} completed`;
      if (taskStartTimestamp) {
        durationSeconds = Math.round((new Date() - taskStartTimestamp) / 1000);
        baseNote += ` (${formatDuration(durationSeconds)})`;
      }
      if (currentTargetMinutes) {
        const targetSeconds = currentTargetMinutes * 60;
        const diff = durationSeconds - targetSeconds;
        if (Math.abs(diff) < 15) {
          baseNote += ` — on target (${currentTargetMinutes}m)`;
        } else if (diff > 0) {
          baseNote += ` — target ${currentTargetMinutes}m, ${formatDuration(diff)} over`;
        } else {
          baseNote += ` — target ${currentTargetMinutes}m, ${formatDuration(-diff)} under`;
        }
      }
    } else {
      baseNote = `Task ${currentTaskNumber} started`;
      taskStartTimestamp = new Date();
      currentTaskDescription = descInput.value.trim();
      const targetVal = parseInt(targetInput.value, 10);
      currentTargetMinutes = (targetVal > 0) ? targetVal : null;
      if (currentTargetMinutes) baseNote += ` — target ${currentTargetMinutes}m`;
    }

    const suffixParts = [];
    if (currentTaskDescription) suffixParts.push(currentTaskDescription);
    if (extra) suffixParts.push(extra);
    const note = suffixParts.length ? `${baseNote} — ${suffixParts.join('; ')}` : baseNote;

    logEntry('Active', note, durationSeconds);
    noteInput.value = '';

    if (taskInProgress) {
      taskInProgress = false;
      taskStartTimestamp = null;
      currentTaskNumber += 1;
      currentTaskDescription = '';
      currentTargetMinutes = null;
      descInput.value = '';
      descInput.disabled = false;
      targetInput.value = '';
      targetInput.disabled = false;
      document.getElementById('taskProgressWrap').style.display = 'none';
    } else {
      taskInProgress = true;
      descInput.disabled = true;
      targetInput.disabled = true;
      document.getElementById('taskProgressWrap').style.display = 'block';
    }
    updateTaskButton();
    updateTotals();
  }

  function handleDowntimeAction() {
    if (sessionEnded) {
      showStatus('⚠ Start a Session first');
      return;
    }
    resetIdleTimer();
    const categorySelect = document.getElementById('downtimeCategorySelect');

    if (!downtimeInProgress && !categorySelect.value) {
      showStatus('⚠ Pick a downtime reason before starting');
      categorySelect.focus();
      return;
    }

    let baseNote, durationSeconds = null, category = null;

    if (downtimeInProgress) {
      baseNote = 'Downtime ended';
      category = currentDowntimeCategory || null;
      if (downtimeStartTimestamp) {
        durationSeconds = Math.round((new Date() - downtimeStartTimestamp) / 1000);
        baseNote += ` (${formatDuration(durationSeconds)})`;
      }
      if (category) baseNote += ` — ${category}`;
    } else {
      baseNote = 'Downtime started';
      downtimeStartTimestamp = new Date();
      currentDowntimeCategory = categorySelect.value;
      category = currentDowntimeCategory;
      baseNote += ` — ${category}`;
      categorySelect.disabled = true;
    }

    logEntry('Downtime', baseNote, durationSeconds, category);

    downtimeInProgress = !downtimeInProgress;
    if (!downtimeInProgress) {
      downtimeStartTimestamp = null;
      currentDowntimeCategory = '';
      categorySelect.value = '';
      categorySelect.disabled = false;
    }
    autoDowntimeActive = false; // any manual toggle clears the auto flag
    updateDowntimeButton();
    updateTotals();
  }

  function updateDowntimeButton() {
    const btn = document.getElementById('downtimeActionBtn');
    btn.textContent = downtimeInProgress ? '▶ End Downtime' : '⏸ Start Downtime';
  }

  function formatDuration(totalSeconds) {
    totalSeconds = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) {
      return `${h}h ${m}m ${s}s`;
    }
    return `${m}m ${s}s`;
  }

  function updateCurrentStatusPill() {
    const pill = document.getElementById('currentStatusPill');
    const text = document.getElementById('currentStatusText');
    if (!pill || !text) return;
    pill.classList.remove('pill-working', 'pill-downtime', 'pill-lunch', 'pill-deadtime');

    if (!sessionEnded && mainSessionType === 'Lunch') {
      pill.classList.add('pill-lunch');
      text.textContent = 'On Lunch Break';
    } else if (taskInProgress) {
      pill.classList.add('pill-working');
      const desc = currentTaskDescription ? ` — ${currentTaskDescription}` : '';
      text.textContent = `Working on Task ${currentTaskNumber}${desc}`;
    } else if (downtimeInProgress) {
      pill.classList.add('pill-downtime');
      const cat = currentDowntimeCategory ? ` (${currentDowntimeCategory})` : '';
      text.textContent = `Downtime${cat}`;
    } else if (deadTimeInProgress) {
      pill.classList.add('pill-deadtime');
      text.textContent = 'Off Headset (between sessions)';
    } else {
      text.textContent = 'Idle — not tracking anything';
    }
  }

  function updateTotals() {
    let totalSeconds = 0;
    let tasksCompleted = 0;
    let totalDowntimeSeconds = 0;
    let totalDeadTimeSeconds = 0;

    // Build a lookup of task-number -> start timestamp (in seconds-of-day),
    // taking entries in chronological order so each "started" pairs with
    // the next "completed" for the same task number. Keyed by bookingId so
    // concurrent bookings' interleaved start/end pairs never cross-contaminate
    // each other's duration calculations.
    const sorted = getViewingEntries().sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
    const openStarts = {};
    const openDowntimeStartByBooking = {};
    let openDeadTimeStart = null; // Dead Time deliberately stays global — see note in inferTaskNumberFromEntries

    sorted.forEach(e => {
      const note = e.note || '';
      const bk = `${e.bookingId || '__none__'}::${e.operator || '__none__'}`;
      const startMatch = note.match(/task\s+(\d+)\s+started/i);
      const completeMatch = note.match(/task\s+(\d+)\s+(completed|compled)/i);
      const downtimeStartMatch = /downtime\s+started/i.test(note);
      const downtimeEndMatch = /downtime\s+(ended|completed)/i.test(note);
      const deadTimeStartMatch = /dead time\s+started/i.test(note);
      const deadTimeEndMatch = /dead time\s+(ended|completed)/i.test(note);

      if (startMatch) {
        openStarts[`${bk}:${startMatch[1]}`] = timeToMinutes(e.timestamp);
      } else if (completeMatch) {
        tasksCompleted += 1;
        const key = `${bk}:${completeMatch[1]}`;
        if (typeof e.durationSeconds === 'number') {
          totalSeconds += e.durationSeconds;
        } else if (openStarts.hasOwnProperty(key)) {
          const diff = timeToMinutes(e.timestamp) - openStarts[key];
          if (diff > 0) totalSeconds += diff;
        }
        delete openStarts[key];
      } else if (downtimeStartMatch) {
        openDowntimeStartByBooking[bk] = timeToMinutes(e.timestamp);
      } else if (downtimeEndMatch) {
        if (typeof e.durationSeconds === 'number') {
          totalDowntimeSeconds += e.durationSeconds;
        } else if (openDowntimeStartByBooking.hasOwnProperty(bk)) {
          const diff = timeToMinutes(e.timestamp) - openDowntimeStartByBooking[bk];
          if (diff > 0) totalDowntimeSeconds += diff;
        }
        delete openDowntimeStartByBooking[bk];
      } else if (deadTimeStartMatch) {
        openDeadTimeStart = timeToMinutes(e.timestamp);
      } else if (deadTimeEndMatch) {
        if (typeof e.durationSeconds === 'number') {
          totalDeadTimeSeconds += e.durationSeconds;
        } else if (openDeadTimeStart !== null) {
          const diff = timeToMinutes(e.timestamp) - openDeadTimeStart;
          if (diff > 0) totalDeadTimeSeconds += diff;
        }
        openDeadTimeStart = null;
      }
    });

    // Total Lunch is now the sum of whole BOOKINGS whose type is "Lunch"
    // (Lunch is a booking type now, not a sub-state within a work booking),
    // scoped to just the currently viewed date.
    let totalLunchSeconds = 0;
    const lunchBookingGroups = {};
    sorted.forEach(e => {
      if (e.type !== 'Session' || !e.bookingId) return;
      if (!lunchBookingGroups[e.bookingId]) lunchBookingGroups[e.bookingId] = [];
      lunchBookingGroups[e.bookingId].push(e);
    });
    Object.values(lunchBookingGroups).forEach(group => {
      const g = group.sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
      const startEntry = g.find(e => /new session started/i.test(e.note || '') || /^joined booking/i.test(e.note || ''));
      if (!startEntry || !/—\s*Lunch\s*(\(|$)/i.test(startEntry.note || '')) return;
      const endEntry = [...g].reverse().find(e => /^session ended/i.test(e.note || ''));
      const startSec = timeToMinutes(g[0].timestamp);
      const endSec = endEntry ? timeToMinutes(endEntry.timestamp) : timeToMinutes(g[g.length - 1].timestamp);
      let diff = endSec - startSec;
      if (diff < 0) diff += 24 * 3600;
      totalLunchSeconds += diff;
    });

    document.getElementById('totalActiveDisplay').textContent = formatDuration(totalSeconds);
    document.getElementById('totalDowntimeDisplay').textContent = formatDuration(totalDowntimeSeconds);
    document.getElementById('totalLunchDisplay').textContent = formatDuration(totalLunchSeconds);
    if (document.getElementById('totalDeadTimeDisplay')) {
      document.getElementById('totalDeadTimeDisplay').textContent = formatDuration(totalDeadTimeSeconds);
    }
    updateSessionDuration(sorted);
    document.getElementById('totalTasksDisplay').textContent = tasksCompleted;
    updateCurrentStatusPill();
    saveToStorage();
  }

  function computeLunchSecondsInSegment(segmentEntries) {
    return computeCategorySecondsInSegment(segmentEntries, 'lunch');
  }

  function computeCategorySecondsInSegment(segmentEntries, category) {
    let total = 0;
    let openStart = null;
    const startRe = new RegExp(category + '\\s+started', 'i');
    const endRe = new RegExp(category + '\\s+(ended|completed)', 'i');
    segmentEntries.forEach(e => {
      const note = e.note || '';
      if (startRe.test(note)) {
        openStart = timeToMinutes(e.timestamp);
      } else if (endRe.test(note)) {
        if (typeof e.durationSeconds === 'number') {
          total += e.durationSeconds;
        } else if (openStart !== null) {
          const diff = timeToMinutes(e.timestamp) - openStart;
          if (diff > 0) total += diff;
        }
        openStart = null;
      }
    });
    return total;
  }

  function updateSessionDuration(sortedEntries) {
    const display = document.getElementById('sessionDurationDisplay');
    const label = document.getElementById('sessionDurationLabel');

    if (!sortedEntries || sortedEntries.length === 0) {
      display.textContent = '0m 0s';
      label.textContent = 'Session 1 Duration';
      return;
    }

    // Scope to just THIS device's own booking's entries — with concurrent
    // bookings now possible, someone else starting a completely separate
    // booking must never truncate or reset this device's own duration
    // calculation. Only my own booking's entries count here.
    const myEntries = sortedEntries.filter(e => e.bookingId === myBookingId);

    if (!myBookingId || myEntries.length === 0) {
      display.textContent = '0m 0s';
      label.textContent = 'Booking Duration';
      document.getElementById('downtimeAlert').style.display = 'none';
      renderSessionsPanel(sortedEntries);
      return;
    }

    const currentSessionEntries = myEntries;
    label.textContent = 'Current Booking Duration';

    const firstSeconds = timeToMinutes(currentSessionEntries[0].timestamp);
    const lastEntrySeconds = timeToMinutes(currentSessionEntries[currentSessionEntries.length - 1].timestamp);

    // Once the session is explicitly ended (or the clock is paused), freeze
    // at the last logged entry. Otherwise treat the session as still
    // ongoing and count up to the current moment.
    const now = new Date();
    const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const endSeconds = (sessionEnded || clockPaused) ? lastEntrySeconds : Math.max(lastEntrySeconds, nowSeconds);

    let diff = endSeconds - firstSeconds;
    if (diff < 0) diff += 24 * 3600; // handle crossing midnight
    if (diff < 0) diff = 0;
    display.textContent = formatDuration(diff);

    updateDowntimeAlert(currentSessionEntries, diff);
    renderSessionsPanel(sortedEntries);
  }

  function updateDowntimeAlert(currentSessionEntries, sessionSpanSeconds) {
    const banner = document.getElementById('downtimeAlert');
    const DOWNTIME_ALERT_THRESHOLD_PCT = 20;

    if (sessionSpanSeconds <= 0) {
      banner.style.display = 'none';
      return;
    }

    const downtimeSecs = computeCategorySecondsInSegment(currentSessionEntries, 'downtime');
    const pct = Math.round((downtimeSecs / sessionSpanSeconds) * 100);

    if (pct >= DOWNTIME_ALERT_THRESHOLD_PCT) {
      banner.style.display = 'block';
      banner.textContent = `⚠ High downtime this session: ${pct}% (${formatDuration(downtimeSecs)} of ${formatDuration(sessionSpanSeconds)})`;
    } else {
      banner.style.display = 'none';
    }
  }

  function renderSessionsPanel(sortedEntries) {
    const panel = document.getElementById('sessionsPanel');
    const list = document.getElementById('sessionsList');

    if (!sortedEntries || sortedEntries.length === 0) {
      panel.style.display = 'none';
      return;
    }

    // Group by actual bookingId — NOT naive chronological splitting, which
    // would incorrectly merge multiple concurrent bookings into one giant
    // segment, or split a single booking apart if someone else's booking
    // started in between.
    const byBooking = {};
    sortedEntries.forEach(e => {
      if (e.type === 'DeadTime' || !e.bookingId) return; // Dead Time isn't a booking
      if (!byBooking[e.bookingId]) byBooking[e.bookingId] = [];
      byBooking[e.bookingId].push(e);
    });

    const bookingIds = Object.keys(byBooking);
    if (bookingIds.length < 2) {
      // Only one booking so far today — no need to clutter the UI with a
      // breakdown of just itself; the totals row already covers it.
      panel.style.display = 'none';
      return;
    }

    // Sort bookings by their own start time so the list reads chronologically.
    const bookingSummaries = bookingIds.map(bookingId => {
      const seg = byBooking[bookingId].sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
      const startEntry = seg.find(e => /new session started/i.test(e.note || '')) || seg[0];
      const endEntry = [...seg].reverse().find(e => /^session ended/i.test(e.note || ''));

      const note = startEntry.note || '';
      const noteClean = note.replace(/\s*\(Policy #\d+\)\s*$/, '').replace(/\s*\(UC #\d+\)\s*$/, '');
      const typeMatch = noteClean.match(/—\s*(.+)$/);
      const type = typeMatch ? typeMatch[1].trim() : 'Unknown';

      return { bookingId, seg, startEntry, endEntry, type,
               startSortVal: entrySortValue(seg[0]) };
    }).sort((a, b) => a.startSortVal - b.startSortVal);

    panel.style.display = 'block';
    const now = new Date();
    const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

    list.innerHTML = bookingSummaries.map((b, i) => {
      const startTs = b.seg[0].timestamp;
      const lastTs = b.seg[b.seg.length - 1].timestamp;
      const ongoing = !b.endEntry;

      const startSec = timeToMinutes(startTs);
      const lastSec = timeToMinutes(lastTs);
      const endSec = ongoing ? Math.max(lastSec, nowSeconds) : lastSec;
      let diff = endSec - startSec;
      if (diff < 0) diff += 24 * 3600;
      // No lunch subtraction here — Lunch is its own separate booking now,
      // so it already shows as its own row rather than needing to be
      // carved out of some other booking's span.
      if (diff < 0) diff = 0;

      const endLabel = ongoing ? 'ongoing' : lastTs;

      return `
        <div class="session-row">
          <div>
            <div class="session-row-name">Booking ${i + 1} — ${escapeHtml(b.type)}</div>
            <div class="session-row-range">${startTs} → ${endLabel}</div>
          </div>
          <div class="session-row-duration ${ongoing ? 'ongoing' : ''}">${formatDuration(diff)}</div>
        </div>
      `;
    }).join('');
  }

  function pad(n) { return n.toString().padStart(2, '0'); }

  let clockPaused = false;
  let sessionEnded = true;
  // Which booking THIS TAB is currently attached to — personal, not synced.
  // Uses sessionStorage (not localStorage) specifically because localStorage
  // is shared across every tab in the same browser, which would make two
  // tabs of the same browser collide onto the same booking automatically.
  // sessionStorage is unique per tab, so opening a second tab for a second
  // concurrent booking genuinely starts independent — the tradeoff is that
  // closing a tab (not just refreshing it) forgets which booking it was on.
  let myBookingId = null;
  const MY_BOOKING_KEY = 'walden_robot_tracker_my_booking_id';
  let clockIntervalId = null;

  function tick() {
    if (clockPaused) return;
    const now = new Date();
    let h = now.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    document.getElementById('clockTime').textContent =
      `${pad(h)}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${ampm}`;
    document.getElementById('clockDate').textContent =
      now.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });

    // If we're following "today" and the calendar date has rolled over
    // (e.g. left the tab open past midnight), automatically move the
    // viewing date forward and give today a fresh set of counters.
    // Nothing is deleted — yesterday's data stays exactly where it is.
    if (followingToday && viewingDate !== todayDateString()) {
      viewingDate = todayDateString();
      updateDateNavUI();
      performReset("New day — counters reset. Yesterday's log is still available via the date picker.");
    }

    const viewEntries = getViewingEntries();
    if (viewEntries.length > 0) {
      const sorted = viewEntries.slice().sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
      updateSessionDuration(sorted);
    }

    updateTaskProgressDisplay();
    updateSessionProgressBar();
  }
  clockIntervalId = setInterval(tick, 1000);
  // Idle-check interval removed — downtime is fully manual now.
  tick();

  function updateTaskProgressDisplay() {
    const wrap = document.getElementById('taskProgressWrap');
    if (!taskInProgress || !taskStartTimestamp) {
      if (wrap) wrap.style.display = 'none';
      return;
    }
    const elapsedSeconds = Math.round((new Date() - taskStartTimestamp) / 1000);
    const label = document.getElementById('taskProgressLabel');
    const fill = document.getElementById('taskProgressFill');
    if (!label || !fill) return;

    if (currentTargetMinutes) {
      const targetSeconds = currentTargetMinutes * 60;
      const pct = Math.min(100, Math.round((elapsedSeconds / targetSeconds) * 100));
      fill.style.width = pct + '%';
      fill.classList.toggle('over-target', elapsedSeconds > targetSeconds);
      const remaining = targetSeconds - elapsedSeconds;
      label.textContent = remaining >= 0
        ? `${formatDuration(elapsedSeconds)} elapsed — ${formatDuration(remaining)} left of ${currentTargetMinutes}m target`
        : `${formatDuration(elapsedSeconds)} elapsed — ${formatDuration(-remaining)} over the ${currentTargetMinutes}m target`;
    } else {
      fill.style.width = '100%';
      fill.classList.remove('over-target');
      label.textContent = `${formatDuration(elapsedSeconds)} elapsed — no target set`;
    }
  }

  function updateSessionProgressBar() {
    const wrap = document.getElementById('sessionProgressWrap');
    if (!wrap) return;
    wrap.style.display = 'block'; // always visible now — content adapts to state

    if (sessionEnded) {
      document.getElementById('sessionProgressOperator').textContent = 'No active booking';
      document.getElementById('sessionProgressElapsed').textContent = 'Start or join a booking to begin';
      document.getElementById('segActive').style.width = '0%';
      document.getElementById('segDowntime').style.width = '0%';
      document.getElementById('segLunch').style.width = '0%';
      return;
    }

    const viewEntries = getViewingEntries().filter(e => e.bookingId === myBookingId);
    if (viewEntries.length === 0) {
      document.getElementById('sessionProgressOperator').textContent = currentOperator || '—';
      document.getElementById('sessionProgressElapsed').textContent = 'Session not started yet';
      document.getElementById('segActive').style.width = '0%';
      document.getElementById('segDowntime').style.width = '0%';
      document.getElementById('segLunch').style.width = '0%';
      return;
    }

    const currentSeg = viewEntries.slice().sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
    if (!currentSeg || currentSeg.length === 0) {
      document.getElementById('sessionProgressOperator').textContent = currentOperator || '—';
      document.getElementById('sessionProgressElapsed').textContent = 'Session not started yet';
      return;
    }

    wrap.style.display = 'block';
    const startSec = timeToMinutes(currentSeg[0].timestamp);
    const now = new Date();
    const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    let totalElapsed = nowSec - startSec;
    if (totalElapsed < 0) totalElapsed += 24 * 3600;
    if (totalElapsed <= 0) totalElapsed = 1;

    const downtimeSecs = computeCategorySecondsInSegment(currentSeg, 'downtime');
    const activeSecs = Math.max(0, totalElapsed - downtimeSecs);

    document.getElementById('segActive').style.width = (activeSecs / totalElapsed * 100) + '%';
    document.getElementById('segDowntime').style.width = (downtimeSecs / totalElapsed * 100) + '%';
    document.getElementById('segLunch').style.width = '0%';
    document.getElementById('sessionProgressOperator').textContent = currentOperator || '—';
    document.getElementById('sessionProgressElapsed').textContent = formatDuration(totalElapsed) + ' elapsed';
  }

  function toggleClock() {
    clockPaused = !clockPaused;
    const btn = document.getElementById('clockToggleBtn');
    if (clockPaused) {
      btn.textContent = '▶ Resume Clock';
      btn.classList.add('paused');
      // Freeze any in-progress task timer so paused time isn't counted
      if (taskInProgress && taskStartTimestamp) {
        pausedTaskElapsed = new Date() - taskStartTimestamp;
        taskStartTimestamp = null;
      }
      if (downtimeInProgress && downtimeStartTimestamp) {
        pausedDowntimeElapsed = new Date() - downtimeStartTimestamp;
        downtimeStartTimestamp = null;
      }
      showStatus('Clock paused');
    } else {
      btn.textContent = '⏸ Pause Clock';
      btn.classList.remove('paused');
      // Resume task timer, accounting for time already elapsed before pause
      if (taskInProgress && pausedTaskElapsed !== null) {
        taskStartTimestamp = new Date(new Date() - pausedTaskElapsed);
        pausedTaskElapsed = null;
      }
      if (downtimeInProgress && pausedDowntimeElapsed !== null) {
        downtimeStartTimestamp = new Date(new Date() - pausedDowntimeElapsed);
        pausedDowntimeElapsed = null;
      }
      tick();
      showStatus('Clock resumed');
    }
    saveToStorage();
  }

  function syncOperatorSelect() {
    const select = document.getElementById('operatorSelect');
    const exists = Array.from(select.options).some(o => o.value === currentOperator);
    if (!exists && currentOperator) {
      const opt = document.createElement('option');
      opt.value = currentOperator;
      opt.textContent = currentOperator;
      select.insertBefore(opt, select.querySelector('option[value="Other"]'));
    }
    select.value = currentOperator || 'Ajar';
  }

  function handleOperatorChange() {
    resetIdleTimer();
    const select = document.getElementById('operatorSelect');
    let value = select.value;
    if (value === 'Other') {
      const name = prompt('Enter operator name:');
      if (!name) {
        select.value = currentOperator; // revert if cancelled
        return;
      }
      value = name.trim();
      // Add as a new option so it stays selectable going forward
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      select.insertBefore(opt, select.querySelector('option[value="Other"]'));
      select.value = value;
    }
    currentOperator = value;
    logEntry('Session', `Operator changed to ${value}`);
    saveToStorage();
  }

  function logEntry(type, note, durationSeconds, category, bookingIdOverride) {
    const now = new Date();
    const entry = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      seq: nextSeq++,
      date: now.toLocaleDateString('en-CA'), // YYYY-MM-DD, unambiguous and sortable
      timestamp: now.toLocaleTimeString(undefined, { hour12: true }),
      type: type,
      note: note || '',
      operator: currentOperator || '',
      category: category || null,
      durationSeconds: (typeof durationSeconds === 'number') ? durationSeconds : null,
      bookingId: (bookingIdOverride !== undefined) ? bookingIdOverride : myBookingId
    };
    entries.push(entry);
    renderLog();
    updateTotals();
    showStatus(`Logged ${type.toLowerCase()} at ${entry.timestamp}`);

    if (!supabaseClient) return;
    supabaseClient.from('entries').insert(entryToRow(entry)).select().single()
      .then(({ data, error }) => {
        if (error) {
          console.warn('Sync failed for entry:', error);
          setSyncStatus('offline — some entries not yet synced', 'status-error');
          return;
        }
        const key = entryContentKey(entry);
        if (pendingDeleteKeys.has(key)) {
          // It was deleted locally before this insert even resolved —
          // clean up the row that just landed rather than resurrecting it.
          pendingDeleteKeys.delete(key);
          supabaseClient.from('entries').delete().eq('id', data.id)
            .then(({ error: delErr }) => {
              if (delErr) console.warn('Cleanup delete failed:', delErr);
            });
          return;
        }
        // Reconcile the local optimistic entry with its real Supabase id,
        // so later edits/deletes target the right row.
        const local = entries.find(e => e.id === entry.id);
        if (local) local.id = data.id;
      })
      .catch(err => {
        console.warn('Sync failed for entry:', err);
        setSyncStatus('offline — some entries not yet synced', 'status-error');
      });
  }

  function showStatus(msg) {
    const el = document.getElementById('status');
    el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2500);
  }

  let currentLogTabFilter = '__all__';

  // A small palette that stays consistent with the app's existing accent
  // colors rather than introducing clashing, overly-bright hues. "All" and
  // "Dead Time" get fixed, sensible colors. Real bookings get one assigned
  // in chronological start order (not hashed) — with hashing, even a
  // handful of bookings can randomly collide while most of an 8-color
  // palette sits unused; sequential assignment guarantees every booking
  // gets a distinct color until the palette is genuinely exhausted.
  const LOG_TAB_COLORS = ['#4fd1b8', '#7c9eff', '#e0512e', '#c77dff', '#5fd97a', '#ff9ecf', '#7fa3e8', '#ffb85c'];
  let logTabColorMap = {};

  function rebuildLogTabColorMap(groupList) {
    // Order by earliest entry, not by most-recent-activity (which is what
    // the tab bar itself is sorted by) — this way a booking's color stays
    // fixed to when it started, and never shifts just because some OTHER
    // booking became more recently active.
    const byStart = groupList.slice().sort((a, b) => {
      const aFirst = a.groupEntries[a.groupEntries.length - 1];
      const bFirst = b.groupEntries[b.groupEntries.length - 1];
      return entrySortValue(aFirst) - entrySortValue(bFirst);
    });
    const map = {};
    byStart.forEach((g, i) => {
      map[g.key] = LOG_TAB_COLORS[i % LOG_TAB_COLORS.length];
    });
    logTabColorMap = map;
  }

  function logTabColorForKey(key) {
    if (key === '__all__') return 'var(--text)';
    if (key === '__unassigned__') return 'var(--muted)';
    return logTabColorMap[key] || 'var(--muted)';
  }

  function renderLog() {
    renderSessionExportList();
    renderActiveBookingsList();
    const body = document.getElementById('logBody');
    const empty = document.getElementById('emptyState');
    const table = document.getElementById('logTable');
    const tabBar = document.getElementById('logTabBar');
    const viewEntries = getViewingEntries();
    document.getElementById('entryCount').textContent = `${viewEntries.length} entr${viewEntries.length === 1 ? 'y' : 'ies'}`;

    if (viewEntries.length === 0) {
      table.style.display = 'none';
      empty.style.display = 'block';
      if (tabBar) tabBar.innerHTML = '';
      empty.textContent = isViewingToday()
        ? "No entries yet — press a button above to start logging."
        : "No entries logged on this day.";
      return;
    }
    table.style.display = 'table';
    empty.style.display = 'none';

    // Group by booking so you can flip between them like tabs, instead of
    // scrolling through one long undifferentiated list — Dead Time (and any
    // legacy entries with no bookingId) get their own tab since they aren't
    // part of any specific booking.
    const groups = {};
    viewEntries.forEach(e => {
      const key = e.bookingId || '__unassigned__';
      if (!groups[key]) groups[key] = [];
      groups[key].push(e);
    });

    const groupList = Object.keys(groups).map(key => {
      const groupEntries = groups[key].sort((a, b) => (entrySortValue(b) - entrySortValue(a)) || (b.seq - a.seq));
      const mostRecentSortVal = entrySortValue(groupEntries[0]);

      let title = 'Dead Time';
      let meta = '';
      if (key !== '__unassigned__') {
        const startEntry = [...groupEntries].reverse().find(e => /new session started/i.test(e.note || '')) || groupEntries[groupEntries.length - 1];
        const note = startEntry.note || '';
        const policyMatch = note.match(/\(Policy #(\d+)\)\s*$/);
        const ucMatch = note.match(/\(UC #(\d+)\)\s*$/);
        const noteClean = note.replace(/\s*\(Policy #\d+\)\s*$/, '').replace(/\s*\(UC #\d+\)\s*$/, '');
        const typeMatch = noteClean.match(/—\s*(.+)$/);
        const type = typeMatch ? typeMatch[1].trim() : 'Unknown';
        const idSuffix = ucMatch ? ` (UC #${ucMatch[1]})` : policyMatch ? ` (Policy #${policyMatch[1]})` : '';
        const operators = [...new Set(groupEntries.map(e => e.operator).filter(Boolean))];
        const first = groupEntries[groupEntries.length - 1].timestamp;
        const last = groupEntries[0].timestamp;
        title = `${type}${idSuffix}`;
        meta = `${escapeHtml(operators.join(', ') || '—')} — ${first} to ${last} — ${groupEntries.length} ${groupEntries.length === 1 ? 'entry' : 'entries'}`;
      } else {
        meta = `${groupEntries.length} ${groupEntries.length === 1 ? 'entry' : 'entries'}`;
      }

      return { key, groupEntries, mostRecentSortVal, title, meta };
    }).sort((a, b) => b.mostRecentSortVal - a.mostRecentSortVal);

    rebuildLogTabColorMap(groupList);

    // If the tab someone was on no longer exists (e.g. its only entry got
    // deleted), fall back to "All" instead of silently showing nothing.
    if (currentLogTabFilter !== '__all__' && !groupList.some(g => g.key === currentLogTabFilter)) {
      currentLogTabFilter = '__all__';
    }

    if (tabBar) {
      const totalCount = viewEntries.length;
      const tabs = [{ key: '__all__', title: 'All', count: totalCount }]
        .concat(groupList.map(g => ({ key: g.key, title: g.title, count: g.groupEntries.length })));
      tabBar.innerHTML = tabs.map(t => `
        <button class="log-tab ${currentLogTabFilter === t.key ? 'active' : ''}" onclick="switchLogTab('${t.key}')">
          <span class="log-tab-bubble" style="background:${logTabColorForKey(t.key)};"></span>
          ${escapeHtml(t.title)} <span class="log-tab-count">${t.count}</span>
        </button>
      `).join('');
    }

    const visibleGroups = (currentLogTabFilter === '__all__')
      ? groupList
      : groupList.filter(g => g.key === currentLogTabFilter);

    body.innerHTML = visibleGroups.map(g => `
      ${currentLogTabFilter === '__all__' ? `
      <tr class="log-group-header">
        <td colspan="6">
          <span class="log-group-title">${escapeHtml(g.title)}</span>
          <span class="log-group-meta">${g.meta}</span>
        </td>
      </tr>` : ''}
      ${g.groupEntries.map(e => `
      <tr data-id="${e.id}">
        <td>${formatDateShort(e.date)}</td>
        <td>${e.timestamp}</td>
        <td><span class="tag ${e.type === 'Active' ? 'tag-active' : e.type === 'Session' ? 'tag-session' : e.type === 'Lunch' ? 'tag-lunch' : e.type === 'DeadTime' ? 'tag-deadtime' : 'tag-downtime'}">${e.type === 'DeadTime' ? 'Dead Time' : e.type}</span></td>
        <td>${e.operator ? escapeHtml(e.operator) : '<span style="color:var(--muted)">—</span>'}</td>
        <td class="note-cell">${e.note ? escapeHtml(e.note) : '<span style="color:var(--muted)">—</span>'}</td>
        <td>
          <button class="edit-btn" onclick="startEdit('${e.id}')">Edit</button>
          ${(e.type === 'Active' && /task\s+\d+\s+(completed|compled)/i.test(e.note || ''))
            ? `<button class="reclassify-btn" onclick="startReclassify('${e.id}')">→Downtime</button>` : ''}
          <button class="delete-btn" onclick="deleteEntry('${e.id}')">Delete</button>
        </td>
      </tr>
      `).join('')}
    `).join('');
  }

  function switchLogTab(key) {
    currentLogTabFilter = key;
    renderLog();
  }

  function startEdit(id) {
    const entry = entries.find(x => x.id === id);
    if (!entry) return;
    const row = document.querySelector(`tr[data-id="${id}"]`);
    const noteCell = row.querySelector('.note-cell');
    noteCell.innerHTML = `
      <input type="text" class="edit-input" value="${escapeAttr(entry.note || '')}" />
    `;
    const actionCell = row.querySelector('.edit-btn').parentElement;
    actionCell.innerHTML = `
      <button class="save-btn" onclick="saveEdit('${id}')">Save</button>
    `;
    row.querySelector('.edit-input').focus();
    row.querySelector('.edit-input').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') saveEdit(id);
    });
  }

  function saveEdit(id) {
    resetIdleTimer();
    const row = document.querySelector(`tr[data-id="${id}"]`);
    const input = row.querySelector('.edit-input');
    const entry = entries.find(x => x.id === id);
    if (entry) {
      entry.note = input.value.trim();
      showStatus(`Note updated for ${entry.timestamp}`);
      if (supabaseClient && !String(id).startsWith('local_')) {
        supabaseClient.from('entries').update({ note: entry.note }).eq('id', id)
          .then(({ error }) => {
            if (error) {
              console.warn('Edit sync failed:', error);
              setSyncStatus('offline — edit not yet synced', 'status-error');
            }
          });
      }
    }
    renderLog();
    updateTotals();
  }

  // Finds the matching "Task N started" entry for a given "Task N completed"
  // entry, so both halves of the pair can be reclassified together and stay
  // internally consistent for all the duration/category calculations that
  // scan for matching start/end pairs.
  function findPairedStartEntry(entry) {
    const m = (entry.note || '').match(/task\s+(\d+)\s+(completed|compled)/i);
    if (!m) return null;
    const taskNum = m[1];
    const sorted = entries.slice().sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
    const idx = sorted.findIndex(e => e.id === entry.id);
    if (idx === -1) return null;
    const startPattern = new RegExp(`task\\s+${taskNum}\\s+started`, 'i');
    for (let i = idx - 1; i >= 0; i--) {
      // Must be the SAME booking — otherwise, with concurrent bookings that
      // happen to share a task number (e.g. two separate "Task 1"s),
      // this could pair with a completely different person's entry.
      if (sorted[i].bookingId !== entry.bookingId) continue;
      if (sorted[i].type === 'Active' && startPattern.test(sorted[i].note || '')) {
        return sorted[i];
      }
    }
    return null;
  }

  function startReclassify(id) {
    resetIdleTimer();
    const entry = entries.find(x => x.id === id);
    if (!entry) return;
    const row = document.querySelector(`tr[data-id="${id}"]`);
    const noteCell = row.querySelector('.note-cell');
    const reasonOptionsHtml = document.getElementById('downtimeCategorySelect').innerHTML;

    noteCell.innerHTML = `
      <div style="font-size:12px;color:var(--muted);margin-bottom:4px;">Reclassify this task as downtime:</div>
      <select class="reclassify-reason-select">${reasonOptionsHtml}</select>
    `;
    const actionCell = row.querySelector('.reclassify-btn').parentElement;
    actionCell.innerHTML = `<button class="save-btn" onclick="saveReclassify('${id}')">Save</button>`;
  }

  function saveReclassify(id) {
    resetIdleTimer();
    const entry = entries.find(x => x.id === id);
    if (!entry) return;
    const row = document.querySelector(`tr[data-id="${id}"]`);
    const reasonSelect = row.querySelector('.reclassify-reason-select');
    const reason = reasonSelect ? reasonSelect.value : '';

    if (!reason) {
      showStatus('⚠ Pick a downtime reason before saving');
      return;
    }

    const pairEntry = findPairedStartEntry(entry);
    const durationText = (typeof entry.durationSeconds === 'number') ? formatDuration(entry.durationSeconds) : null;

    entry.type = 'Downtime';
    entry.category = reason;
    entry.note = durationText
      ? `Downtime ended (${durationText}) — ${reason}`
      : `Downtime ended — ${reason}`;

    const updates = [{ id: entry.id, type: entry.type, category: entry.category, note: entry.note }];

    if (pairEntry) {
      pairEntry.type = 'Downtime';
      pairEntry.category = reason;
      pairEntry.note = `Downtime started — ${reason}`;
      updates.push({ id: pairEntry.id, type: pairEntry.type, category: pairEntry.category, note: pairEntry.note });
    }

    showStatus(pairEntry
      ? `Reclassified as Downtime (${reason}) — both start and end updated`
      : `Reclassified as Downtime (${reason}) — matching start entry not found, only this row updated`);

    if (supabaseClient) {
      updates.forEach(u => {
        if (String(u.id).startsWith('local_')) return;
        supabaseClient.from('entries').update({ type: u.type, category: u.category, note: u.note }).eq('id', u.id)
          .then(({ error }) => {
            if (error) {
              console.warn('Reclassify sync failed:', error);
              setSyncStatus('offline — reclassify not yet synced', 'status-error');
            }
          });
      });
    }

    renderLog();
    updateTotals();
  }

  function deleteEntry(id) {
    resetIdleTimer();
    const entry = entries.find(x => x.id === id);
    if (!entry) return;
    if (!confirm(`Delete this entry?\n\n${entry.timestamp} — ${entry.type} — ${entry.note || '(no note)'}\n\nThis cannot be undone, for the whole team.`)) {
      return;
    }

    entries = entries.filter(x => x.id !== id);
    renderLog();
    updateTotals();
    showStatus('Entry deleted');

    if (!supabaseClient) return;

    if (String(id).startsWith('local_')) {
      // The insert for this entry hasn't resolved yet — we don't know its
      // real Supabase id. Remember its content so that whenever the insert
      // (or the realtime echo of it) does land, it gets deleted immediately
      // instead of quietly reappearing.
      pendingDeleteKeys.add(entryContentKey(entry));
      return;
    }

    supabaseClient.from('entries').delete().eq('id', id)
      .then(({ error }) => {
        if (error) {
          console.warn('Delete sync failed:', error);
          setSyncStatus('offline — deletion not yet synced', 'status-error');
        }
      });
  }

  function timeToMinutes(t) {
    const m = t.match(/(\d+):(\d+):(\d+)\s*(AM|PM)?/i);
    if (!m) return 0;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const sec = parseInt(m[3], 10);
    const ampm = (m[4] || '').toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return h * 3600 + min * 60 + sec;
  }

  function todayDateString() {
    return new Date().toLocaleDateString('en-CA');
  }

  function getTodayEntries() {
    const today = todayDateString();
    return entries.filter(e => e.date === today);
  }

  function getViewingEntries() {
    return entries.filter(e => e.date === viewingDate);
  }

  function isViewingToday() {
    return viewingDate === todayDateString();
  }

  function updateDateNavUI() {
    const today = todayDateString();
    const label = document.getElementById('dateNavLabel');
    const dateInput = document.getElementById('viewingDateInput');
    const todayBtn = document.getElementById('dateNavTodayBtn');
    const banner = document.getElementById('historyBanner');

    dateInput.value = viewingDate;

    if (viewingDate === today) {
      label.textContent = 'Today';
      label.classList.remove('is-history');
      todayBtn.style.display = 'none';
      banner.style.display = 'none';
    } else {
      const d = new Date(viewingDate + 'T00:00:00');
      label.textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      label.classList.add('is-history');
      todayBtn.style.display = 'inline-block';
      banner.style.display = 'flex';
    }

    setActionControlsEnabled(viewingDate === today);
  }

  function setActionControlsEnabled(enabled) {
    const ids = ['sessionToggleBtn',
                 'reopenSessionBtn', 'taskDescInput', 'targetDurationInput',
                 'noteInput', 'downtimeCategorySelect', 'operatorSelect'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.tagName === 'BUTTON') {
        el.disabled = !enabled;
        el.style.cursor = enabled ? 'pointer' : 'not-allowed';
      } else {
        // Don't force-enable inputs that are intentionally locked mid-task/downtime
        if (enabled) {
          // leave existing lock state (task/downtime in progress) alone
        } else {
          el.disabled = true;
        }
      }
    });
    // task +/- counter buttons
    document.querySelectorAll('.task-decr, .task-incr').forEach(btn => {
      btn.disabled = !enabled || taskInProgress;
      btn.style.opacity = (!enabled || taskInProgress) ? '0.5' : '1';
    });
    // Task Timer / Downtime / Lunch have their OWN gate (booking status) —
    // re-derive them here too so history-mode and booking-status combine
    // correctly instead of one silently overriding the other.
    updateWorkControlsGating();
  }

  function navigateDate(deltaDays) {
    const d = new Date(viewingDate + 'T00:00:00');
    d.setDate(d.getDate() + deltaDays);
    viewingDate = d.toLocaleDateString('en-CA');
    followingToday = (viewingDate === todayDateString());
    refreshForDateChange();
  }

  function handleDateInputChange() {
    const dateInput = document.getElementById('viewingDateInput');
    if (!dateInput.value) return;
    viewingDate = dateInput.value;
    followingToday = (viewingDate === todayDateString());
    refreshForDateChange();
  }

  function jumpToToday() {
    viewingDate = todayDateString();
    followingToday = true;
    refreshForDateChange();
  }

  function refreshForDateChange() {
    updateDateNavUI();
    renderLog();
    updateTotals();
  }

  function formatDateShort(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function entrySortValue(e) {
    const timeSec = timeToMinutes(e.timestamp);
    if (e.date) {
      const d = new Date(e.date + 'T00:00:00');
      if (!isNaN(d.getTime())) {
        const daysSinceEpoch = Math.floor(d.getTime() / 86400000);
        return daysSinceEpoch * 100000 + timeSec;
      }
    }
    return timeSec; // legacy entries without a date fall back to time-only ordering
  }

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function extractReason(note) {
    // Notes look like "Downtime ended (5m 7s) — restarting the stack"
    // Pull out anything after the dash as the human-readable reason.
    const parts = (note || '').split('—');
    if (parts.length > 1) return parts.slice(1).join('—').trim();
    return '';
  }

  function computeLunchBookingLog(sortedEntries) {
    const byBooking = {};
    sortedEntries.forEach(e => {
      if (e.type !== 'Session' || !e.bookingId) return;
      if (!byBooking[e.bookingId]) byBooking[e.bookingId] = [];
      byBooking[e.bookingId].push(e);
    });

    const events = [];
    Object.values(byBooking).forEach(group => {
      const seg = group.sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
      const startEntry = seg.find(e => /new session started/i.test(e.note || '') || /^joined booking/i.test(e.note || ''));
      if (!startEntry || !/—\s*Lunch\s*(\(|$)/i.test(startEntry.note || '')) return;
      const endEntry = [...seg].reverse().find(e => /^session ended/i.test(e.note || ''));
      const startSec = timeToMinutes(seg[0].timestamp);
      const endSec = endEntry ? timeToMinutes(seg[seg.length - 1].timestamp) : timeToMinutes(seg[seg.length - 1].timestamp);
      let diff = endSec - startSec;
      if (diff < 0) diff += 24 * 3600;
      const operators = [...new Set(seg.map(e => e.operator).filter(Boolean))];
      events.push({ operator: operators.join(', ') || '', duration: formatDuration(diff) });
    });
    return events;
  }

  function computeDurationLog(sortedEntries, regexWord, entryType) {
    entryType = entryType || regexWord;
    const events = [];
    let openStart = null, openOperator = null, openStartNote = null;
    sortedEntries.forEach(e => {
      if ((e.type || '').toLowerCase() !== entryType.toLowerCase()) return;
      const note = e.note || '';
      if (new RegExp(regexWord + '\\s+started', 'i').test(note)) {
        openStart = e.timestamp;
        openOperator = e.operator || '';
        openStartNote = note;
      } else if (new RegExp(regexWord + '\\s+(ended|completed)', 'i').test(note)) {
        const dm = note.match(/\((\d+)m\s+(\d+)s\)/);
        const duration = dm ? `${dm[1]}m ${dm[2]}s` : '?';
        const reason = extractReason(note) || extractReason(openStartNote || '');
        events.push({ operator: e.operator || openOperator || '', duration, reason: reason || 'No reason logged' });
        openStart = null; openOperator = null; openStartNote = null;
      }
    });
    return events;
  }

  function secondsToClockLabel(seconds) {
    let s = ((seconds % 86400) + 86400) % 86400; // normalize
    let h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')} ${ampm}`;
  }

  function computeOccupiedIntervals(segmentEntries) {
    const intervals = [];
    const openTaskStarts = {};
    let openDowntime = null, openLunch = null;
    segmentEntries.forEach(e => {
      const note = e.note || '';
      let m = note.match(/task\s+(\d+)\s+started/i);
      if (m) { openTaskStarts[m[1]] = timeToMinutes(e.timestamp); return; }
      m = note.match(/task\s+(\d+)\s+(completed|compled)/i);
      if (m) {
        const s = openTaskStarts[m[1]];
        if (s != null) intervals.push([s, timeToMinutes(e.timestamp)]);
        delete openTaskStarts[m[1]];
        return;
      }
      if (/downtime\s+started/i.test(note)) { openDowntime = timeToMinutes(e.timestamp); return; }
      if (/downtime\s+(ended|completed)/i.test(note)) {
        if (openDowntime != null) intervals.push([openDowntime, timeToMinutes(e.timestamp)]);
        openDowntime = null;
        return;
      }
      if (/lunch\s+started/i.test(note)) { openLunch = timeToMinutes(e.timestamp); return; }
      if (/lunch\s+(ended|completed)/i.test(note)) {
        if (openLunch != null) intervals.push([openLunch, timeToMinutes(e.timestamp)]);
        openLunch = null;
        return;
      }
    });
    return intervals.sort((a, b) => a[0] - b[0]);
  }

  function computeUnaccountedGaps(segmentEntries) {
    if (segmentEntries.length === 0) return [];
    const startSec = timeToMinutes(segmentEntries[0].timestamp);
    const endSec = timeToMinutes(segmentEntries[segmentEntries.length - 1].timestamp);
    const occupied = computeOccupiedIntervals(segmentEntries);

    const merged = [];
    occupied.forEach(iv => {
      if (merged.length && iv[0] <= merged[merged.length - 1][1]) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], iv[1]);
      } else {
        merged.push([iv[0], iv[1]]);
      }
    });

    const gaps = [];
    let cursor = startSec;
    merged.forEach(iv => {
      if (iv[0] > cursor) gaps.push([cursor, iv[0]]);
      cursor = Math.max(cursor, iv[1]);
    });
    if (endSec > cursor) gaps.push([cursor, endSec]);

    // Ignore sub-minute noise — only real gaps matter for this report
    return gaps
      .filter(g => (g[1] - g[0]) >= 60)
      .map(g => ({ startLabel: secondsToClockLabel(g[0]), endLabel: secondsToClockLabel(g[1]), seconds: g[1] - g[0] }));
  }

  function computeSessionSummaries(sortedEntries) {
    // Group by actual bookingId — same fix already applied to renderSessionsPanel.
    // Naive chronological splitting (on any "new session started" marker)
    // would incorrectly merge or split concurrent bookings that happen on
    // the same day, producing wrong durations in the summary report.
    const byBooking = {};
    sortedEntries.forEach(e => {
      if (e.type === 'DeadTime' || !e.bookingId) return; // not a booking
      if (!byBooking[e.bookingId]) byBooking[e.bookingId] = [];
      byBooking[e.bookingId].push(e);
    });

    const bookingIds = Object.keys(byBooking);
    const segments = bookingIds
      .map(id => byBooking[id].sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq)))
      .sort((a, b) => entrySortValue(a[0]) - entrySortValue(b[0]));

    return segments.filter(s => s.length > 0).map((seg, i) => {
      const startTs = seg[0].timestamp;
      const lastTs = seg[seg.length - 1].timestamp;
      const endEntry = [...seg].reverse().find(e => /^session ended/i.test(e.note || ''));
      const isOngoing = !endEntry;
      const startSec = timeToMinutes(startTs);
      const lastSec = timeToMinutes(lastTs);
      let rawSpan = lastSec - startSec;
      if (rawSpan < 0) rawSpan += 24 * 3600;
      const downtimeSecs = computeCategorySecondsInSegment(seg, 'downtime');

      // No lunch subtraction — Lunch is its own separate booking now, so
      // it was never part of this segment's own span to begin with.
      let withDowntime = rawSpan;
      if (withDowntime < 0) withDowntime = 0;
      let withoutDowntime = withDowntime - downtimeSecs;
      if (withoutDowntime < 0) withoutDowntime = 0;

      const operators = [...new Set(seg.map(e => e.operator).filter(Boolean))];
      return {
        number: i + 1,
        operators: operators.join(', ') || '—',
        start: startTs,
        end: isOngoing ? 'ongoing' : lastTs,
        durationWithDowntimeSeconds: withDowntime,
        durationWithoutDowntimeSeconds: withoutDowntime,
        downtimeSeconds: downtimeSecs,
        durationWithDowntime: formatDuration(withDowntime),
        durationWithoutDowntime: formatDuration(withoutDowntime),
        downtimeDuration: formatDuration(downtimeSecs),
        gaps: (function() { return computeUnaccountedGaps(seg); })(),
        get unaccountedSeconds() { return this.gaps.reduce((sum, g) => sum + g.seconds, 0); }
      };
    });
  }

  function computeDowntimeByCategory(sortedEntries) {
    const totals = {};
    const openCategories = {};
    sortedEntries.forEach(e => {
      if (e.type !== 'Downtime') return;
      const key = `${e.bookingId || '__none__'}:${e.operator || '__none__'}`;
      const note = e.note || '';
      if (/downtime\s+started/i.test(note)) {
        openCategories[key] = e.category || 'Unspecified';
      } else if (/downtime\s+(ended|completed)/i.test(note)) {
        const category = e.category || openCategories[key] || 'Unspecified';
        const dur = (typeof e.durationSeconds === 'number') ? e.durationSeconds : 0;
        totals[category] = (totals[category] || 0) + dur;
        delete openCategories[key];
      }
    });
    return Object.entries(totals)
      .map(([category, seconds]) => ({ category, seconds, duration: formatDuration(seconds) }))
      .sort((a, b) => b.seconds - a.seconds);
  }

  function computeOperatorStats(sortedEntries) {
    const stats = {};
    const openTaskStarts = {};
    const openDowntimeStarts = {};
    sortedEntries.forEach(e => {
      const op = e.operator || 'Unknown';
      if (!stats[op]) stats[op] = { active: 0, downtime: 0 };
      const bk = e.bookingId || '__none__';
      const note = e.note || '';
      let m = note.match(/task\s+(\d+)\s+started/i);
      if (m) { openTaskStarts[`${bk}:${op}:${m[1]}`] = { sec: timeToMinutes(e.timestamp), op }; return; }
      m = note.match(/task\s+(\d+)\s+(completed|compled)/i);
      if (m) {
        const key = `${bk}:${op}:${m[1]}`;
        const started = openTaskStarts[key];
        if (started) {
          const dur = (typeof e.durationSeconds === 'number') ? e.durationSeconds : Math.max(0, timeToMinutes(e.timestamp) - started.sec);
          stats[started.op].active += dur;
        }
        delete openTaskStarts[key];
        return;
      }
      if (/downtime\s+started/i.test(note)) { openDowntimeStarts[`${bk}:${op}`] = { sec: timeToMinutes(e.timestamp), op }; return; }
      if (/downtime\s+(ended|completed)/i.test(note)) {
        const key = `${bk}:${op}`;
        const started = openDowntimeStarts[key];
        if (started) {
          const dur = (typeof e.durationSeconds === 'number') ? e.durationSeconds : Math.max(0, timeToMinutes(e.timestamp) - started.sec);
          stats[started.op].downtime += dur;
        }
        delete openDowntimeStarts[key];
        return;
      }
    });
    return Object.entries(stats).map(([operator, v]) => {
      const total = v.active + v.downtime;
      const pct = total > 0 ? Math.round((v.downtime / total) * 100) : 0;
      return { operator, active: formatDuration(v.active), downtime: formatDuration(v.downtime), downtimePct: pct };
    }).sort((a, b) => b.downtimePct - a.downtimePct);
  }

  function computeDowntimeByHour(sortedEntries) {
    const byHour = {};
    const openStarts = {};
    sortedEntries.forEach(e => {
      if (e.type !== 'Downtime') return;
      const key = `${e.bookingId || '__none__'}:${e.operator || '__none__'}`;
      const note = e.note || '';
      if (/downtime\s+started/i.test(note)) {
        openStarts[key] = timeToMinutes(e.timestamp);
      } else if (/downtime\s+(ended|completed)/i.test(note)) {
        const openStart = openStarts[key];
        if (openStart != null) {
          const dur = (typeof e.durationSeconds === 'number') ? e.durationSeconds : Math.max(0, timeToMinutes(e.timestamp) - openStart);
          const hour = Math.floor(openStart / 3600);
          byHour[hour] = (byHour[hour] || 0) + dur;
        }
        delete openStarts[key];
      }
    });
    return Object.entries(byHour)
      .map(([hour, seconds]) => {
        const h = parseInt(hour, 10);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const display = h % 12 === 0 ? 12 : h % 12;
        return { hourLabel: `${display}:00 ${ampm}`, seconds, duration: formatDuration(seconds) };
      })
      .sort((a, b) => b.seconds - a.seconds);
  }

  function escapeHtmlText(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function generateSummaryDoc() {
    const viewEntries = getViewingEntries();
    if (viewEntries.length === 0) {
      showStatus(`Nothing to summarize for ${formatDateShort(viewingDate)}`);
      return;
    }
    const sorted = viewEntries.slice().sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
    const operators = [...new Set(sorted.map(e => e.operator).filter(Boolean))];
    const tasksCompleted = document.getElementById('totalTasksDisplay').textContent;
    const activeTime = document.getElementById('totalActiveDisplay').textContent;
    const downtimeTime = document.getElementById('totalDowntimeDisplay').textContent;
    const lunchTime = document.getElementById('totalLunchDisplay').textContent;
    const deadTime = document.getElementById('totalDeadTimeDisplay') ? document.getElementById('totalDeadTimeDisplay').textContent : '0m 0s';

    const sessionSummaries = computeSessionSummaries(sorted);
    const downtimeLog = computeDurationLog(sorted, 'downtime');
    const lunchLog = computeLunchBookingLog(sorted);
    const deadTimeLog = computeDurationLog(sorted, 'dead time', 'DeadTime');
    const downtimeByCategory = computeDowntimeByCategory(sorted);
    const operatorStats = computeOperatorStats(sorted);
    const downtimeByHour = computeDowntimeByHour(sorted);
    const totalUnaccountedSeconds = sessionSummaries.reduce((sum, s) => sum + s.unaccountedSeconds, 0);
    const totalUnaccounted = formatDuration(totalUnaccountedSeconds);

    const totalWithDowntimeSeconds = sessionSummaries.reduce((sum, s) => sum + s.durationWithDowntimeSeconds, 0);
    const totalWithoutDowntimeSeconds = sessionSummaries.reduce((sum, s) => sum + s.durationWithoutDowntimeSeconds, 0);
    const totalSessionWithDowntime = formatDuration(totalWithDowntimeSeconds);
    const totalSessionWithoutDowntime = formatDuration(totalWithoutDowntimeSeconds);

    const dateStr = new Date(viewingDate + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const summaryFilename = `robot_use_summary_${viewingDate}.html`;

    const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Robot Use Summary — ${dateStr}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 24px; color: #111827; line-height: 1.5; }
  h1 { color: #00211e; margin-bottom: 4px; }
  .subtitle { color: #6b7280; margin-top: 0; margin-bottom: 28px; }
  h2 { color: #00211e; border-bottom: 2px solid #e5e7eb; padding-bottom: 6px; margin-top: 36px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th { background: #00211e; color: white; text-align: left; padding: 10px 12px; font-size: 13px; }
  td { padding: 10px 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
  tr:nth-child(even) td { background: #f8fafc; }
  .stats { display: flex; gap: 16px; margin: 20px 0; flex-wrap: wrap; }
  .stat-box { background: #e6fffa; border-radius: 10px; padding: 14px 18px; flex: 1; min-width: 130px; text-align: center; }
  .stat-value { font-size: 24px; font-weight: 700; color: #00211e; }
  .stat-label { font-size: 12px; color: #475569; margin-top: 4px; }
  .no-print { margin: 24px 0; }
  button { background: #00211e; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; cursor: pointer; font-weight: 600; }
  @media print { .no-print { display: none; } }
</style></head><body>
  <h1>Robot Use Summary</h1>
  <p class="subtitle">${dateStr} — Operators: ${operators.join(', ') || 'N/A'}</p>

  <div class="no-print">
    <button onclick="window.print()">🖨 Print / Save as PDF</button>
    <button onclick="downloadSummary()">⬇ Download as File</button>
  </div>
  <script>
    function downloadSummary() {
      const blob = new Blob([document.documentElement.outerHTML], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '${summaryFilename}';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  <\/script>

  <div class="stats">
    <div class="stat-box"><div class="stat-value">${totalSessionWithDowntime}</div><div class="stat-label">Total Session Time (incl. downtime)</div></div>
    <div class="stat-box"><div class="stat-value">${totalSessionWithoutDowntime}</div><div class="stat-label">Total Session Time (excl. downtime)</div></div>
    <div class="stat-box"><div class="stat-value">${downtimeTime}</div><div class="stat-label">Total Downtime</div></div>
  </div>
  <div class="stats">
    <div class="stat-box"><div class="stat-value">${tasksCompleted}</div><div class="stat-label">Tasks Completed</div></div>
    <div class="stat-box"><div class="stat-value">${activeTime}</div><div class="stat-label">Total Active Time</div></div>
    <div class="stat-box"><div class="stat-value">${lunchTime}</div><div class="stat-label">Total Lunch</div></div>
    <div class="stat-box"><div class="stat-value">${deadTime}</div><div class="stat-label">Total Dead Time</div></div>
    <div class="stat-box"><div class="stat-value">${totalUnaccounted}</div><div class="stat-label">Unaccounted Time</div></div>
  </div>

  <h2>Session Breakdown</h2>
  <table>
    <tr><th>Session</th><th>Operator(s)</th><th>Start</th><th>End</th><th>Time (incl. downtime)</th><th>Time (excl. downtime)</th><th>Downtime</th><th>Unaccounted</th></tr>
    ${sessionSummaries.map(s => `<tr><td>Session ${s.number}</td><td>${escapeHtmlText(s.operators)}</td><td>${s.start}</td><td>${s.end}</td><td>${s.durationWithDowntime}</td><td>${s.durationWithoutDowntime}</td><td>${s.downtimeDuration}</td><td>${formatDuration(s.unaccountedSeconds)}</td></tr>`).join('')}
  </table>

  ${sessionSummaries.some(s => s.gaps.length > 0) ? `<h2>Unaccounted Time Gaps</h2>
  <p style="color:#6b7280;font-size:13px;">Time between logged events that wasn't recorded as active work, downtime, or lunch.</p>
  <table>
    <tr><th>Session</th><th>From</th><th>To</th><th>Duration</th></tr>
    ${sessionSummaries.flatMap(s => s.gaps.map(g => `<tr><td>Session ${s.number}</td><td>${g.startLabel}</td><td>${g.endLabel}</td><td>${formatDuration(g.seconds)}</td></tr>`)).join('')}
  </table>` : ''}

  <h2>Downtime Log</h2>
  ${downtimeLog.length ? `<table>
    <tr><th>Operator</th><th>Duration</th><th>Reason</th></tr>
    ${downtimeLog.map(d => `<tr><td>${escapeHtmlText(d.operator)}</td><td>${escapeHtmlText(d.duration)}</td><td>${escapeHtmlText(d.reason)}</td></tr>`).join('')}
  </table>` : '<p>No downtime recorded.</p>'}

  ${downtimeByCategory.length ? `<h2>Top Downtime Causes</h2>
  <table>
    <tr><th>Category</th><th>Total Time</th><th>% of Downtime</th></tr>
    ${downtimeByCategory.map(c => `<tr><td>${escapeHtmlText(c.category)}</td><td>${c.duration}</td><td>${downtimeByCategory.reduce((s,x)=>s+x.seconds,0) > 0 ? Math.round(c.seconds / downtimeByCategory.reduce((s,x)=>s+x.seconds,0) * 100) : 0}%</td></tr>`).join('')}
  </table>` : ''}

  ${operatorStats.length > 1 ? `<h2>Per-Operator Breakdown</h2>
  <table>
    <tr><th>Operator</th><th>Active Time</th><th>Downtime</th><th>Downtime %</th></tr>
    ${operatorStats.map(o => `<tr><td>${escapeHtmlText(o.operator)}</td><td>${o.active}</td><td>${o.downtime}</td><td>${o.downtimePct}%</td></tr>`).join('')}
  </table>` : ''}

  ${downtimeByHour.length ? `<h2>Downtime by Time of Day</h2>
  <table>
    <tr><th>Hour</th><th>Total Downtime</th></tr>
    ${downtimeByHour.map(h => `<tr><td>${h.hourLabel}</td><td>${h.duration}</td></tr>`).join('')}
  </table>` : ''}

  ${lunchLog.length ? `<h2>Lunch Log</h2>
  <table>
    <tr><th>Operator</th><th>Duration</th></tr>
    ${lunchLog.map(l => `<tr><td>${escapeHtmlText(l.operator)}</td><td>${escapeHtmlText(l.duration)}</td></tr>`).join('')}
  </table>` : ''}

  ${deadTimeLog.length ? `<h2>Dead Time Log</h2>
  <p style="color:#6b7280;font-size:13px;">Time between sessions, before an operator is on headset. Separate from downtime — not a fault or delay, just time the robot wasn't staffed.</p>
  <table>
    <tr><th>Operator</th><th>Duration</th></tr>
    ${deadTimeLog.map(d => `<tr><td>${escapeHtmlText(d.operator)}</td><td>${escapeHtmlText(d.duration)}</td></tr>`).join('')}
  </table>` : ''}

</body></html>`;

    const win = window.open('', '_blank');
    if (!win) {
      showStatus('Pop-up blocked — allow pop-ups to view the summary');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    showStatus('Summary generated in a new tab');
    uploadToDrive(summaryFilename, html, 'text/html');
  }

  function exportCSV() {
    if (entries.length === 0) { showStatus('Nothing to export yet'); return; }
    let csv = 'Date,Time,Type,Operator,Category,Note,Booking ID\n';
    entries.forEach(e => {
      csv += `"${e.date || ''}","${e.timestamp}","${e.type}","${(e.operator || '').replace(/"/g, '""')}","${(e.category || '').replace(/"/g, '""')}","${(e.note || '').replace(/"/g, '""')}","${e.bookingId || ''}"\n`;
    });
    const filename = buildDatedFilename('robot_use_log', 'csv');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showStatus('CSV exported');
    uploadToDrive(filename, csv, 'text/csv');
  }

  function buildDatedFilename(base, ext) {
    const dates = [...new Set(entries.map(e => e.date).filter(Boolean))].sort();
    if (dates.length === 0) return `${base}_${todayDateString()}.${ext}`;
    if (dates.length === 1) return `${base}_${dates[0]}.${ext}`;
    return `${base}_${dates[0]}_to_${dates[dates.length - 1]}.${ext}`;
  }

  // Enumerates every session across the FULL history (not just one day),
  // used by the "Export Specific Sessions" picker so someone can filter by
  // type or hand-pick exactly which runs to include in an export.
  function computeAllSessions() {
    // Group by bookingId rather than splitting chronologically — with
    // concurrent bookings, entries from different bookings interleave in
    // the raw timeline, so a simple chronological split would incorrectly
    // mix them together.
    const byBooking = {};
    const noBookingId = []; // entries logged before booking_id existed
    entries.forEach(e => {
      if (e.type === 'DeadTime') return; // deliberately has no booking — not a session
      if (e.bookingId) {
        if (!byBooking[e.bookingId]) byBooking[e.bookingId] = [];
        byBooking[e.bookingId].push(e);
      } else {
        noBookingId.push(e);
      }
    });

    const sessions = Object.keys(byBooking).map((bookingId, i) => {
      const seg = byBooking[bookingId].sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
      const startEntry = seg.find(e => e.type === 'Session' && /new session started/i.test(e.note || ''));
      const endEntry = [...seg].reverse().find(e => e.type === 'Session' && /^session ended/i.test(e.note || ''));

      let type = 'Unknown';
      let policyNumber = null;
      let ucNumber = null;
      if (startEntry) {
        const note = startEntry.note || '';
        const policyMatch = note.match(/\(Policy #(\d+)\)\s*$/);
        const ucMatch = note.match(/\(UC #(\d+)\)\s*$/);
        policyNumber = policyMatch ? policyMatch[1] : null;
        ucNumber = ucMatch ? ucMatch[1] : null;
        const noteClean = note.replace(/\s*\(Policy #\d+\)\s*$/, '').replace(/\s*\(UC #\d+\)\s*$/, '');
        const typeMatch = noteClean.match(/—\s*(.+)$/);
        type = typeMatch ? typeMatch[1].trim() : 'Unknown';
      }

      const operators = [...new Set(seg.map(e => e.operator).filter(Boolean))];
      const sorted = seg.slice().sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));

      return {
        id: bookingId,
        index: i + 1,
        type: type,
        policyNumber: ucNumber ? null : policyNumber,
        ucNumber: ucNumber,
        operators: operators.join(', ') || '—',
        startDate: sorted[0].date,
        startTime: sorted[0].timestamp,
        endDate: sorted[sorted.length - 1].date,
        endTime: sorted[sorted.length - 1].timestamp,
        ongoing: !endEntry,
        entries: seg
      };
    });

    // Older entries logged before bookings existed (booking_id is null) —
    // keep them exportable too, grouped as one legacy "session" per old
    // chronological-split boundary, so nothing from before this update
    // becomes invisible to the export picker.
    if (noBookingId.length > 0) {
      const sortedLegacy = noBookingId.sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
      const legacySegments = [];
      let segStart = 0;
      sortedLegacy.forEach((e, idx) => {
        if (e.type === 'Session' && /new session started/i.test(e.note || '')) {
          if (idx > segStart) legacySegments.push(sortedLegacy.slice(segStart, idx));
          segStart = idx;
        }
      });
      legacySegments.push(sortedLegacy.slice(segStart));

      legacySegments.filter(seg => seg.length > 0).forEach((seg, i) => {
        const startEntry = seg.find(e => e.type === 'Session' && /new session started/i.test(e.note || ''));
        let type = 'Unknown (legacy)';
        if (startEntry) {
          const typeMatch = (startEntry.note || '').match(/—\s*(.+)$/);
          if (typeMatch) type = typeMatch[1].trim() + ' (legacy)';
        }
        const operators = [...new Set(seg.map(e => e.operator).filter(Boolean))];
        sessions.push({
          id: `legacy_${i}`,
          index: sessions.length + i + 1,
          type: type,
          policyNumber: null,
          ucNumber: null,
          operators: operators.join(', ') || '—',
          startDate: seg[0].date,
          startTime: seg[0].timestamp,
          endDate: seg[seg.length - 1].date,
          endTime: seg[seg.length - 1].timestamp,
          ongoing: false,
          entries: seg
        });
      });
    }

    return sessions.sort((a, b) => (entrySortValue({date:a.startDate,timestamp:a.startTime}) - entrySortValue({date:b.startDate,timestamp:b.startTime})));
  }

  function renderSessionExportList() {
    const container = document.getElementById('sessionExportList');
    if (!container) return;
    const sessions = computeAllSessions();

    if (sessions.length === 0) {
      container.innerHTML = '<div class="session-export-empty">No sessions logged yet.</div>';
      updateSessionExportButtonCount();
      return;
    }

    // Preserve whatever's currently checked across re-renders (e.g. after a
    // realtime update comes in while someone's mid-selection).
    const previouslyChecked = new Set(
      Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value)
    );

    container.innerHTML = sessions.map(s => {
      const policyText = s.ucNumber ? ` (UC #${s.ucNumber})` : s.policyNumber ? ` (Policy #${s.policyNumber})` : '';
      const dateRange = (s.startDate === s.endDate)
        ? `${formatDateShort(s.startDate)}, ${s.startTime} – ${s.endTime}`
        : `${formatDateShort(s.startDate)} ${s.startTime} → ${formatDateShort(s.endDate)} ${s.endTime}`;
      const ongoingTag = s.ongoing ? ' <span style="color:var(--accent2);">(ongoing)</span>' : '';
      const checked = previouslyChecked.has(s.id) ? 'checked' : '';
      return `
        <label class="session-export-row">
          <input type="checkbox" value="${s.id}" data-type="${escapeAttr(s.type)}" onchange="updateSessionExportButtonCount()" ${checked} />
          <div>
            <div class="session-export-row-label">Session ${s.index} — ${escapeHtml(s.type)}${policyText}${ongoingTag}</div>
            <div class="session-export-row-meta">${dateRange} — ${escapeHtml(s.operators)}</div>
          </div>
        </label>
      `;
    }).join('');
    updateSessionExportButtonCount();
  }

  function quickSelectSessionsByType() {
    const select = document.getElementById('sessionFilterTypeSelect');
    const value = select.value;
    const checkboxes = document.querySelectorAll('#sessionExportList input[type="checkbox"]');
    if (value === '__none__') {
      checkboxes.forEach(cb => { cb.checked = false; });
    } else if (value === '__all__') {
      checkboxes.forEach(cb => { cb.checked = true; });
    } else if (value) {
      checkboxes.forEach(cb => { cb.checked = (cb.dataset.type === value); });
    }
    select.value = '';
    updateSessionExportButtonCount();
  }

  function updateSessionExportButtonCount() {
    const checked = document.querySelectorAll('#sessionExportList input[type="checkbox"]:checked');
    const btn = document.getElementById('exportSelectedSessionsBtn');
    if (btn) btn.textContent = `⬇ Export Selected Sessions (${checked.length})`;
  }

  function exportSelectedSessions() {
    const checked = Array.from(document.querySelectorAll('#sessionExportList input[type="checkbox"]:checked'));
    if (checked.length === 0) {
      showStatus('⚠ Check at least one session to export');
      return;
    }
    const sessions = computeAllSessions();
    const selectedIds = new Set(checked.map(cb => cb.value));
    const selectedSessions = sessions.filter(s => selectedIds.has(s.id));
    const selectedEntries = selectedSessions.flatMap(s => s.entries);

    let csv = 'Date,Time,Type,Operator,Category,Note,Booking ID\n';
    selectedEntries
      .sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq))
      .forEach(e => {
        csv += `"${e.date || ''}","${e.timestamp}","${e.type}","${(e.operator || '').replace(/"/g, '""')}","${(e.category || '').replace(/"/g, '""')}","${(e.note || '').replace(/"/g, '""')}","${e.bookingId || ''}"\n`;
      });

    const filename = `robot_use_log_selected_sessions_${selectedSessions.length}.csv`;
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showStatus(`Exported ${selectedSessions.length} session${selectedSessions.length === 1 ? '' : 's'}`);
  }

  function importCSV(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    let filesProcessed = 0;
    let totalImported = 0;

    function processFile(file) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const rows = parseCSV(e.target.result);
            if (rows.length < 2) { resolve(0); return; }
            const header = rows[0].map(h => h.trim().toLowerCase());
            const timeIdx = header.indexOf('time');
            const typeIdx = header.indexOf('type');
            const noteIdx = header.indexOf('note');
            const operatorIdx = header.indexOf('operator');
            const dateIdx = header.indexOf('date');
            const categoryIdx = header.indexOf('category');
            const bookingIdIdx = header.indexOf('booking id');
            if (timeIdx === -1 || typeIdx === -1) { resolve(0); return; }

            let imported = 0;
            for (let i = 1; i < rows.length; i++) {
              const row = rows[i];
              if (!row[timeIdx]) continue;
              const note = noteIdx !== -1 ? (row[noteIdx] || '') : '';
              const operator = operatorIdx !== -1 ? (row[operatorIdx] || '') : '';
              // Legacy CSVs (pre-date-tracking) have no Date column — fall back
              // to today's date so old imports still sort sensibly.
              const rowDate = (dateIdx !== -1 && row[dateIdx]) ? row[dateIdx] : new Date().toLocaleDateString('en-CA');
              const category = categoryIdx !== -1 ? (row[categoryIdx] || null) : null;
              const bookingId = bookingIdIdx !== -1 ? (row[bookingIdIdx] || null) : null;
              entries.push({
                id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                seq: nextSeq++,
                date: rowDate,
                timestamp: row[timeIdx],
                type: row[typeIdx] || 'Active',
                note: note,
                operator: operator,
                category: category,
                bookingId: bookingId,
                durationSeconds: parseDurationFromNote(note)
              });
              imported++;
            }
            resolve(imported);
          } catch (err) {
            resolve(0);
          }
        };
        reader.readAsText(file);
      });
    }

    Promise.all(files.map(processFile)).then((counts) => {
      totalImported = counts.reduce((a, b) => a + b, 0);
      dedupeEntries();
      renderLog();
      inferTaskNumberFromEntries();
      updateTotals();

      // Pick up the operator from the most recent entry, if one was recorded
      const sorted = entries.slice().sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
      const lastWithOperator = [...sorted].reverse().find(e => e.operator);
      if (lastWithOperator) {
        currentOperator = lastWithOperator.operator;
        syncOperatorSelect();
      }

      currentTaskDescription = '';
      const descInput = document.getElementById('taskDescInput');
      descInput.value = '';
      descInput.disabled = taskInProgress;

      // Show today's view after an import so the live state is visible
      viewingDate = todayDateString();
      followingToday = true;
      updateDateNavUI();
      renderLog();

      // Push newly-imported rows (still carrying temp local_ ids) to Supabase
      // so the rest of the team sees them too.
      if (supabaseClient) {
        const toInsert = entries.filter(e => String(e.id).startsWith('local_'));
        if (toInsert.length > 0) {
          supabaseClient.from('entries').insert(toInsert.map(entryToRow)).select()
            .then(({ data, error }) => {
              if (error) {
                console.warn('Import sync failed:', error);
                setSyncStatus('offline — imported entries not yet synced', 'status-error');
                return;
              }
              // Reconcile each imported entry with its real Supabase id by
              // matching content, since insert order isn't guaranteed.
              (data || []).forEach(row => {
                const match = entries.find(e =>
                  String(e.id).startsWith('local_') &&
                  e.date === row.entry_date && e.timestamp === row.entry_time &&
                  e.type === row.type && e.note === row.note &&
                  (e.operator || '') === (row.operator || '')
                );
                if (match) match.id = row.id;
              });
            });
        }
      }

      const fileWord = files.length === 1 ? 'file' : 'files';
      showStatus(`Combined ${totalImported} entr${totalImported === 1 ? 'y' : 'ies'} from ${files.length} ${fileWord}`);
      event.target.value = '';
    });
  }

  function dedupeEntries() {
    // Remove exact duplicate rows that can happen when the same export
    // gets imported more than once. Includes operator and bookingId (not
    // just date/time/type/note) so two different people's concurrent
    // bookings that happen to share boilerplate text at the same second
    // never get mistaken for duplicates of each other.
    const seen = new Set();
    entries = entries.filter(e => {
      const key = `${e.date || ''}|${e.timestamp}|${e.type}|${e.note}|${e.operator || ''}|${e.bookingId || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], next = text[i + 1];
      if (inQuotes) {
        if (c === '"' && next === '"') { field += '"'; i++; }
        else if (c === '"') { inQuotes = false; }
        else { field += c; }
      } else {
        if (c === '"') { inQuotes = true; }
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c === '\r') { /* skip */ }
        else { field += c; }
      }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
  }

  function parseDurationFromNote(note) {
    const m = (note || '').match(/\((\d+)m\s+(\d+)s\)/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  function inferTaskNumberFromEntries() {
    // Restore which booking THIS TAB was attached to FIRST, and verify it's
    // still actually open (someone else might have ended it while we were
    // away) — everything below this point (task/downtime/lunch state) needs
    // to be scoped to just this booking's own entries, since multiple
    // concurrent bookings now exist and their entries interleave together
    // in the shared, synced entries list.
    let storedBookingId = null;
    try { storedBookingId = sessionStorage.getItem(MY_BOOKING_KEY); } catch (err) { /* ignore */ }

    if (storedBookingId) {
      const active = computeActiveBookings();
      const stillActive = active.find(b => b.bookingId === storedBookingId);
      if (stillActive) {
        myBookingId = storedBookingId;
        mainSessionType = stillActive.type;
        currentPolicyNumber = stillActive.policyNumber ? parseInt(stillActive.policyNumber, 10) : null;
        currentUcNumber = stillActive.ucNumber ? parseInt(stillActive.ucNumber, 10) : null;
        sessionEnded = false;
      } else {
        // It was ended (by us or someone else) since we last checked in —
        // don't keep pointing at a closed booking.
        try { sessionStorage.removeItem(MY_BOOKING_KEY); } catch (err) { /* ignore */ }
        myBookingId = null;
        sessionEnded = true;
      }
    } else {
      myBookingId = null;
      sessionEnded = true;
    }

    // Task numbering stays shared across the WHOLE booking (numbers keep
    // incrementing regardless of who's doing them) — but whether a task is
    // currently IN PROGRESS is tracked per-operator, so two different
    // people sharing one booking can each have their own task running
    // without interfering with each other's button state.
    let maxCompleted = 0;
    let maxStarted = 0;
    getTodayEntries()
      .filter(e => e.bookingId === myBookingId)
      .forEach(e => {
        const note = e.note || '';
        const m = note.match(/task\s+(\d+)\s+(started|completed|compled)/i);
        if (!m) return;
        const num = parseInt(m[1], 10);
        const kind = m[2].toLowerCase();
        if (kind === 'started') {
          maxStarted = Math.max(maxStarted, num);
        } else {
          maxCompleted = Math.max(maxCompleted, num);
        }
      });
    currentTaskNumber = Math.max(maxCompleted, maxStarted) + (maxStarted > maxCompleted ? 0 : 1);

    // Now find MY OWN most recent task event specifically — this is what
    // actually determines whether the Task Timer button on THIS device
    // shows Start or Stop.
    const myTaskEvents = getTodayEntries()
      .filter(e => e.bookingId === myBookingId && e.operator === currentOperator)
      .filter(e => /task\s+\d+\s+(started|completed|compled)/i.test(e.note || ''))
      .sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
    if (myTaskEvents.length > 0) {
      const lastMine = myTaskEvents[myTaskEvents.length - 1];
      taskInProgress = /started/i.test(lastMine.note || '');
      taskStartTimestamp = taskInProgress ? parseTimestampToDate(lastMine.timestamp) : null;
      if (taskInProgress) {
        const m = (lastMine.note || '').match(/task\s+(\d+)\s+started/i);
        if (m) currentTaskNumber = parseInt(m[1], 10);
      }
    } else {
      taskInProgress = false;
      taskStartTimestamp = null;
    }

    const typeSelect = document.getElementById('mainSessionTypeSelect');
    const otherInput = document.getElementById('mainSessionOtherInput');
    const policyInput = document.getElementById('policyNumberInput');
    const ucInput = document.getElementById('ucNumberInput');
    const startBookingForm = document.getElementById('startBookingForm');
    const endBookingRow = document.getElementById('endBookingRow');
    if (typeSelect) {
      const isKnownOption = Array.from(typeSelect.options).some(o => o.value === mainSessionType);
      typeSelect.value = !sessionEnded ? (isKnownOption ? mainSessionType : 'Other') : '';
      typeSelect.disabled = !sessionEnded;
      if (!sessionEnded && !isKnownOption && otherInput) {
        otherInput.value = mainSessionType;
        otherInput.style.display = 'block';
        otherInput.disabled = true;
      }
    }
    if (policyInput) {
      policyInput.value = currentPolicyNumber || '';
      policyInput.disabled = !sessionEnded;
    }
    if (ucInput) {
      ucInput.value = currentUcNumber || '';
      ucInput.disabled = !sessionEnded;
    }
    if (startBookingForm) startBookingForm.style.display = sessionEnded ? 'block' : 'none';
    if (endBookingRow) endBookingRow.style.display = sessionEnded ? 'none' : 'block';

    // Downtime — scoped to MY booking only. This is the fix for the bug
    // where one person ending their downtime was affecting everyone else's
    // downtime status too, since this used to scan ALL of today's downtime
    // entries globally instead of just the ones tied to this tab's booking.
    const downtimeEvents = getTodayEntries()
      .filter(e => e.type === 'Downtime' && e.bookingId === myBookingId && e.operator === currentOperator)
      .slice()
      .sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
    if (downtimeEvents.length > 0) {
      const last = downtimeEvents[downtimeEvents.length - 1];
      downtimeInProgress = /started/i.test(last.note || '');
      downtimeStartTimestamp = downtimeInProgress ? parseTimestampToDate(last.timestamp) : null;
    } else {
      downtimeInProgress = false;
      downtimeStartTimestamp = null;
    }

    // Dead Time deliberately stays global (bookingId is always null for
    // these entries by design) — it represents "not attached to any
    // booking," which isn't a per-booking concept the same way task/
    // downtime/lunch are.
    const deadTimeEvents = getTodayEntries()
      .filter(e => e.type === 'DeadTime')
      .slice()
      .sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
    if (deadTimeEvents.length > 0) {
      const last = deadTimeEvents[deadTimeEvents.length - 1];
      deadTimeInProgress = /started/i.test(last.note || '');
      deadTimeStartTimestamp = deadTimeInProgress ? parseTimestampToDate(last.timestamp) : null;
    }

    updateSessionButton();
    updateTaskButton();
    updateDowntimeButton();
  }
  function parseTimestampToDate(t) {
    const seconds = timeToMinutes(t);
    const d = new Date();
    d.setHours(Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60, 0);
    return d;
  }

  function performReset(statusMessage) {
    // Resets today's LIVE tracking counters only. Never deletes any entries —
    // history is preserved and stays browsable via the date navigator.
    // Deliberately does NOT touch currentOperator — resetting task numbering
    // has no logical connection to who's currently operating, and silently
    // reverting to a default operator would undermine the whole point of
    // requiring an explicit "who's operating" choice at login.
    currentTaskNumber = 1;
    taskInProgress = false;
    taskStartTimestamp = null;
    currentTaskDescription = '';
    downtimeInProgress = false;
    downtimeStartTimestamp = null;
    autoDowntimeActive = false;
    currentDowntimeCategory = '';
    lunchInProgress = false;
    lunchStartTimestamp = null;
    deadTimeInProgress = false;
    deadTimeStartTimestamp = null;
    // Deliberately NOT touching sessionEnded/myBookingId here — resetting
    // today's task numbering shouldn't kick anyone off an active booking.
    lastActivityTime = new Date();
    currentTargetMinutes = null;
    const descInput = document.getElementById('taskDescInput');
    descInput.value = '';
    descInput.disabled = false;
    const targetInput = document.getElementById('targetDurationInput');
    targetInput.value = '';
    targetInput.disabled = false;
    document.getElementById('taskProgressWrap').style.display = 'none';

    const categorySelect = document.getElementById('downtimeCategorySelect');
    categorySelect.value = '';
    categorySelect.disabled = false;
    updateSessionButton();
    updateTaskButton();
    updateDowntimeButton();
    renderLog();
    updateTotals();
    showStatus(statusMessage);
  }

  function startNewDay() {
    // The date navigator already separates days automatically — this button
    // is now just a manual counter reset for today, with an optional export
    // first. Nothing is ever deleted.
    viewingDate = todayDateString();
    followingToday = true;
    updateDateNavUI();
    const todayEntries = getTodayEntries();
    if (todayEntries.length === 0) {
      showStatus('Starting fresh — counters reset');
      performReset('Counters reset for today');
      return;
    }
    if (confirm("Export today's log, then reset today's counters for a fresh start? (Nothing is deleted — you can still browse today via the date picker.)")) {
      exportCSV();
      performReset('Exported. Counters reset for today');
    }
  }

  function clearLog() {
    // Scoped to whatever day is currently being viewed — never touches other days.
    const viewEntries = getViewingEntries();
    if (viewEntries.length === 0) return;
    const label = isViewingToday() ? "today's" : `${formatDateShort(viewingDate)}'s`;
    if (confirm(`Clear all ${viewEntries.length} entries for ${label} log? This cannot be undone for the whole team. Other days are not affected.`)) {
      const dateBeingCleared = viewingDate;
      entries = entries.filter(e => e.date !== dateBeingCleared);
      if (isViewingToday()) {
        performReset('Log cleared for today');
      } else {
        renderLog();
        updateTotals();
        showStatus(`Cleared ${label} log`);
      }
      if (supabaseClient) {
        supabaseClient.from('entries').delete().eq('entry_date', dateBeingCleared)
          .then(({ error }) => {
            if (error) {
              console.warn('Delete sync failed:', error);
              setSyncStatus('offline — deletion not yet synced', 'status-error');
            }
          });
      }
    }
  }

  function handleMainSessionTypeChange() {
    const select = document.getElementById('mainSessionTypeSelect');
    const otherInput = document.getElementById('mainSessionOtherInput');
    const ucRow = document.getElementById('ucNumberRow');
    const policyRow = document.getElementById('policyNumberRow');
    otherInput.style.display = (select.value === 'Other') ? 'block' : 'none';
    ucRow.style.display = (select.value === 'UC Data Collect') ? 'flex' : 'none';
    policyRow.style.display = (select.value === 'Policy Training') ? 'flex' : 'none';
  }

  let currentPolicyNumber = null;
  let currentUcNumber = null;

  function updateWorkControlsGating() {
    // Run Time / Downtime only make sense once THIS device is
    // attached to a booking, AND only while viewing today (not browsing
    // read-only history) — this is the "order of operations" enforcement.
    const enabled = !sessionEnded && isViewingToday();
    ['taskActionBtn', 'downtimeActionBtn'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      const isMidAction = (id === 'taskActionBtn' && taskInProgress) ||
                           (id === 'downtimeActionBtn' && downtimeInProgress);
      if (isMidAction) {
        // A "stop what you're currently doing" button must ALWAYS be
        // clickable, no matter what — force it enabled rather than leaving
        // it however it happened to be before, which could leave someone
        // stuck unable to end their own downtime/task if it got
        // disabled for any other reason right around when it started.
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        return;
      }
      btn.disabled = !enabled;
      btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
    });
  }

  function generateBookingId() {
    return `booking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function bookingIdentifier(type, ucNum, policyNum) {
    // The thing that makes a booking "the same" for join-vs-start purposes:
    // for UC Data Collect it's the UC number; for Policy Training it's the
    // Policy number; anything else is identified by type alone.
    if (type === 'UC Data Collect') return `UC Data Collect|${ucNum || ''}`;
    if (type === 'Policy Training') return `Policy Training|${policyNum || ''}`;
    return `${type}|`;
  }

  // Scans the FULL history (every device, every day) for bookings that have
  // started but not yet ended — the live "what's running right now" list.
  function computeActiveBookings() {
    const byId = {};
    entries.forEach(e => {
      if (e.type !== 'Session' || !e.bookingId) return;
      if (!byId[e.bookingId]) byId[e.bookingId] = [];
      byId[e.bookingId].push(e);
    });

    const active = [];
    Object.keys(byId).forEach(bookingId => {
      const evs = byId[bookingId].sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
      const startEv = evs.find(e => /new session started/i.test(e.note || ''));
      const endEv = evs.find(e => /^session ended/i.test(e.note || ''));
      if (!startEv || endEv) return; // no start, or already closed — not active

      const note = startEv.note || '';
      const policyMatch = note.match(/\(Policy #(\d+)\)\s*$/);
      const ucMatch = note.match(/\(UC #(\d+)\)\s*$/);
      let noteClean = note.replace(/\s*\(Policy #\d+\)\s*$/, '').replace(/\s*\(UC #\d+\)\s*$/, '');
      const typeMatch = noteClean.match(/—\s*(.+)$/);

      const operators = [...new Set(evs.map(e => e.operator).filter(Boolean))];

      active.push({
        bookingId,
        type: typeMatch ? typeMatch[1].trim() : 'Unknown',
        policyNumber: policyMatch ? policyMatch[1] : null,
        ucNumber: ucMatch ? ucMatch[1] : null,
        operators: operators.join(', ') || '—',
        startDate: startEv.date,
        startTime: startEv.timestamp
      });
    });
    return active;
  }

  function renderActiveBookingsList() {
    const container = document.getElementById('activeBookingsList');
    if (!container) return;
    const active = computeActiveBookings();
    if (active.length === 0) {
      container.innerHTML = '<div class="active-bookings-empty">Nothing running right now.</div>';
      return;
    }
    container.innerHTML = active.map(b => {
      const idText = b.ucNumber ? ` (UC #${b.ucNumber})` : (b.policyNumber ? ` (Policy #${b.policyNumber})` : '');
      const isMine = b.bookingId === myBookingId;
      return `
        <div class="active-booking-row">
          <div>
            <div class="active-booking-label">${escapeHtml(b.type)}${idText}${isMine ? ' <span style="color:var(--accent);">— you</span>' : ''}</div>
            <div class="active-booking-meta">Started ${formatDateShort(b.startDate)} ${b.startTime} — ${escapeHtml(b.operators)}</div>
          </div>
          ${isMine ? '' : `<button class="join-booking-btn" onclick="joinBooking('${b.bookingId}')">Join</button>`}
        </div>
      `;
    }).join('');
  }

  function attachToBooking(bookingId, type, policyNumber, ucNumber) {
    myBookingId = bookingId;
    mainSessionType = type;
    currentPolicyNumber = policyNumber;
    currentUcNumber = ucNumber;
    sessionEnded = false;
    try { sessionStorage.setItem(MY_BOOKING_KEY, bookingId); } catch (err) { /* ignore */ }
    closeDeadTime();

    const startBookingForm = document.getElementById('startBookingForm');
    if (startBookingForm) startBookingForm.style.display = 'none';
    const endRow = document.getElementById('endBookingRow');
    if (endRow) endRow.style.display = 'block';

    updateSessionButton();
    updateTotals();
    renderActiveBookingsList();
  }

  function detachFromMyBooking() {
    myBookingId = null;
    mainSessionType = '';
    currentPolicyNumber = null;
    currentUcNumber = null;
    sessionEnded = true;
    try { sessionStorage.removeItem(MY_BOOKING_KEY); } catch (err) { /* ignore */ }

    const typeSelect = document.getElementById('mainSessionTypeSelect');
    const otherInput = document.getElementById('mainSessionOtherInput');
    const policyInput = document.getElementById('policyNumberInput');
    const ucInput = document.getElementById('ucNumberInput');
    if (typeSelect) { typeSelect.value = ''; typeSelect.disabled = false; }
    if (otherInput) { otherInput.value = ''; otherInput.style.display = 'none'; otherInput.disabled = false; }
    if (policyInput) { policyInput.value = ''; policyInput.disabled = false; }
    if (ucInput) { ucInput.value = ''; ucInput.disabled = false; }

    const startBookingForm = document.getElementById('startBookingForm');
    if (startBookingForm) startBookingForm.style.display = 'block';
    const endRow = document.getElementById('endBookingRow');
    if (endRow) endRow.style.display = 'none';

    startDeadTime();
    updateSessionButton();
    updateTotals();
    renderActiveBookingsList();
  }

  function joinBooking(bookingId) {
    resetIdleTimer();
    if (myBookingId) {
      showStatus('⚠ End your current booking before joining another one');
      return;
    }
    const active = computeActiveBookings();
    const booking = active.find(b => b.bookingId === bookingId);
    if (!booking) {
      showStatus('⚠ That booking is no longer active');
      renderActiveBookingsList();
      return;
    }
    logEntry('Session', `Joined booking — ${booking.type}${booking.ucNumber ? ` (UC #${booking.ucNumber})` : booking.policyNumber ? ` (Policy #${booking.policyNumber})` : ''}`, null, null, bookingId);
    attachToBooking(bookingId, booking.type, booking.policyNumber, booking.ucNumber);
    showStatus(`Joined ${booking.type}`);
  }

  function startOrJoinBooking() {
    resetIdleTimer();
    if (myBookingId) {
      showStatus('⚠ You are already attached to a booking');
      return;
    }
    const typeSelect = document.getElementById('mainSessionTypeSelect');
    const otherInput = document.getElementById('mainSessionOtherInput');
    const policyInput = document.getElementById('policyNumberInput');
    const ucInput = document.getElementById('ucNumberInput');

    const chosenType = (typeSelect.value === 'Other') ? otherInput.value.trim() : typeSelect.value;
    if (!chosenType) {
      showStatus('⚠ Pick a booking type before starting');
      typeSelect.focus();
      return;
    }

    const ucVal = parseInt(ucInput.value, 10);
    const ucNumber = (ucVal > 0) ? ucVal : null;
    if (chosenType === 'UC Data Collect' && !ucNumber) {
      showStatus('⚠ Enter a UC # before starting a UC Data Collect booking');
      ucInput.focus();
      return;
    }
    const policyVal = parseInt(policyInput.value, 10);
    const policyNumber = (policyVal > 0) ? policyVal : null;

    // If a booking with this same identity is already running, offer to
    // join it instead of starting a duplicate, confusing, overlapping one.
    const identity = bookingIdentifier(chosenType, ucNumber, policyNumber);
    const existing = computeActiveBookings().find(b =>
      bookingIdentifier(b.type, b.ucNumber, b.policyNumber) === identity
    );
    if (existing) {
      showStatus(`⚠ That's already running — click "Join" on it in the Active Bookings list above instead`);
      return;
    }

    const bookingId = generateBookingId();
    const idSuffix = ucNumber ? ` (UC #${ucNumber})` : policyNumber ? ` (Policy #${policyNumber})` : '';
    logEntry('Session', `New session started — ${chosenType}${idSuffix}`, null, null, bookingId);
    currentTaskNumber = 1; // a genuinely new booking starts fresh, not continuing the last one's count
    taskInProgress = false;
    taskStartTimestamp = null;
    updateTaskButton();
    attachToBooking(bookingId, chosenType, policyNumber, ucNumber);
    showStatus('Booking started');
  }

  function endBooking() {
    resetIdleTimer();
    if (!myBookingId) return;
    if (taskInProgress) {
      showStatus('⚠ Stop the Run Time before ending the booking');
      return;
    }
    if (downtimeInProgress) {
      showStatus('⚠ End Downtime before ending the booking');
      return;
    }
    const idSuffix = currentUcNumber ? ` (UC #${currentUcNumber})` : currentPolicyNumber ? ` (Policy #${currentPolicyNumber})` : '';
    logEntry('Session', `Session ended — ${mainSessionType}${idSuffix}`, null, null, myBookingId);
    showStatus('Booking ended');
    detachFromMyBooking();
  }

  function startDeadTime() {
    if (deadTimeInProgress) return;
    deadTimeInProgress = true;
    deadTimeStartTimestamp = new Date();
    logEntry('DeadTime', 'Dead time started', null, null, null);
  }

  function closeDeadTime() {
    if (!deadTimeInProgress || !deadTimeStartTimestamp) return;
    const durationSeconds = Math.round((new Date() - deadTimeStartTimestamp) / 1000);
    logEntry('DeadTime', `Dead time ended (${formatDuration(durationSeconds)})`, durationSeconds, null, null);
    deadTimeInProgress = false;
    deadTimeStartTimestamp = null;
  }

  function updateSessionButton() {
    const status = document.getElementById('myBookingStatus');
    if (status) {
      if (sessionEnded) {
        status.textContent = "You're not attached to a booking yet.";
        status.classList.remove('active');
      } else {
        const idText = currentUcNumber ? ` (UC #${currentUcNumber})` : currentPolicyNumber ? ` (Policy #${currentPolicyNumber})` : '';
        status.textContent = `You're on: ${mainSessionType}${idText}`;
        status.classList.add('active');
      }
    }
    updateWorkControlsGating();
  }


  // ---- Page mode: two genuinely separate HTML files sharing this one
  // app.js and style.css, instead of one file with a URL parameter. Each
  // HTML file sets window.PAGE_MODE before loading this script:
  //   index.html            -> window.PAGE_MODE = 'data'    (Sim/UC/Other)
  //   policy-training.html  -> window.PAGE_MODE = 'policy'  (Policy Training/Other)
  const pageMode = (window.PAGE_MODE === 'policy') ? 'policy' : 'data';

  function applyPageMode() {
    const typeSelect = document.getElementById('mainSessionTypeSelect');
    const navLink = document.getElementById('pageNavLink');
    if (!typeSelect || !navLink) return;

    Array.from(typeSelect.options).forEach(opt => {
      if (opt.classList.contains('opt-data')) {
        opt.style.display = (pageMode === 'data') ? '' : 'none';
      } else if (opt.classList.contains('opt-policy')) {
        opt.style.display = (pageMode === 'policy') ? '' : 'none';
      }
    });

    if (pageMode === 'policy') {
      navLink.textContent = '→ DATA COLLECTION';
      navLink.href = 'index.html';
    } else {
      navLink.textContent = '→ POLICY TRAINING';
      navLink.href = 'policy-training.html';
    }
  }

  viewingDate = todayDateString();
  followingToday = true;
  loadPrefs();

  let authClient = null;

  function getAuthClient() {
    if (!authClient) authClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return authClient;
  }

  async function attemptLogin() {
    const input = document.getElementById('passcodeInput');
    const errorEl = document.getElementById('loginError');
    const btn = document.getElementById('passcodeSubmitBtn');
    const passcode = input.value;
    if (!passcode) {
      errorEl.textContent = 'Enter the passcode first';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Checking…';
    errorEl.textContent = '';

    try {
      const client = getAuthClient();
      const { error } = await client.auth.signInWithPassword({
        email: SHARED_LOGIN_EMAIL,
        password: passcode
      });
      if (error) {
        errorEl.textContent = 'Wrong passcode — try again';
        btn.disabled = false;
        btn.textContent = 'Unlock';
        return;
      }
      unlockApp();
    } catch (err) {
      errorEl.textContent = 'Connection error — try again';
      btn.disabled = false;
      btn.textContent = 'Unlock';
    }
  }

  function unlockApp() {
    document.getElementById('loginOverlay').style.display = 'none';
    document.getElementById('operatorPromptOverlay').style.display = 'flex';
  }

  function handleOperatorPromptChange() {
    const select = document.getElementById('operatorPromptSelect');
    const otherInput = document.getElementById('operatorPromptOtherInput');
    otherInput.style.display = (select.value === 'Other') ? 'block' : 'none';
  }

  function confirmOperatorPrompt() {
    const select = document.getElementById('operatorPromptSelect');
    const otherInput = document.getElementById('operatorPromptOtherInput');
    const chosen = (select.value === 'Other') ? otherInput.value.trim() : select.value;
    if (!chosen) {
      otherInput.focus();
      return;
    }
    currentOperator = chosen;
    document.getElementById('operatorPromptOverlay').style.display = 'none';
    document.getElementById('mainWrap').style.display = 'block';
    initApp();
  }

  document.getElementById('passcodeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptLogin();
  });

  document.getElementById('operatorPromptOtherInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmOperatorPrompt();
  });

  async function initApp() {
    applyPageMode();
    supabaseClient = getAuthClient();
    const hasData = await initSupabaseSync();

    // Now that entries are loaded from the shared database, figure out
    // today's live tracking state (task/downtime/lunch/session) from them.
    inferTaskNumberFromEntries();

    updateTaskButton();
    updateDowntimeButton();
    updateSessionButton();
    updateDateNavUI();
    updateTotals();
    renderLog();
    syncOperatorSelect();
    const descInputInit = document.getElementById('taskDescInput');
    descInputInit.value = currentTaskDescription || '';
    descInputInit.disabled = taskInProgress;
    const targetInputInit = document.getElementById('targetDurationInput');
    targetInputInit.disabled = taskInProgress;
    if (taskInProgress) document.getElementById('taskProgressWrap').style.display = 'block';
    const categorySelectInit = document.getElementById('downtimeCategorySelect');
    categorySelectInit.value = downtimeInProgress ? (currentDowntimeCategory || '') : '';
    categorySelectInit.disabled = downtimeInProgress;
    lastActivityTime = new Date();

    if (hasData) {
      showStatus(`Loaded ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from the shared team log`);
    }
  }

  // On page load, check for an already-signed-in session (from a previous
  // visit in this browser) so the team doesn't need to re-enter the
  // passcode every single time — only once per browser, until it's cleared.
  (async function checkExistingSession() {
    if (typeof supabase === 'undefined') {
      document.getElementById('loginError').textContent = 'Sync library failed to load — check your connection';
      return;
    }
    const client = getAuthClient();
    const { data } = await client.auth.getSession();
    if (data && data.session) {
      unlockApp();
    }
    // Otherwise, the login overlay just stays visible, waiting for input.
  })();