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
    if (!canLogRightNow() && !taskInProgress) {
      showStatus('⚠ After 6:30 PM — view only, logging resumes tomorrow');
      return;
    }
    resetIdleTimer();
    // If downtime or lunch is currently open and we're about to start a new
    // task, close it first so it doesn't overlap with active work.
    if (!taskInProgress && downtimeInProgress) {
      autoCloseDowntime('task started');
    }
    if (!taskInProgress && lunchInProgress) {
      autoCloseLunch('task started');
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
    updateSessionButton();
  }

  function handleDowntimeAction() {
    if (sessionEnded) {
      showStatus('⚠ Start a Session first');
      return;
    }
    if (!canLogRightNow() && !downtimeInProgress) {
      showStatus('⚠ After 6:30 PM — view only, logging resumes tomorrow');
      return;
    }
    resetIdleTimer();
    const categorySelect = document.getElementById('downtimeCategorySelect');

    if (!downtimeInProgress && lunchInProgress) {
      autoCloseLunch('downtime started');
    }

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

  function autoCloseLunch(reason) {
    if (!lunchInProgress || !lunchStartTimestamp) return;
    const durationSeconds = Math.round((new Date() - lunchStartTimestamp) / 1000);
    logEntry('Lunch', `Lunch ended (${formatDuration(durationSeconds)}) — auto-closed: ${reason}`, durationSeconds);
    lunchInProgress = false;
    lunchStartTimestamp = null;
    updateLunchButton();
    updateTotals();
  }

  function handleLunchAction() {
    if (sessionEnded) {
      showStatus('⚠ Start a Session first');
      return;
    }
    if (!canLogRightNow() && !lunchInProgress) {
      showStatus('⚠ After 6:30 PM — view only, logging resumes tomorrow');
      return;
    }
    resetIdleTimer();

    // Lunch, Downtime, and Run Time are mutually exclusive — starting one
    // cleanly closes whichever of the other two happens to be open, same
    // as Downtime already does when a task starts.
    if (!lunchInProgress) {
      if (downtimeInProgress) autoCloseDowntime('lunch started');
      if (taskInProgress) {
        const durationSeconds = taskStartTimestamp ? Math.round((new Date() - taskStartTimestamp) / 1000) : 0;
        logEntry('Active', `Task ${currentTaskNumber} completed (${formatDuration(durationSeconds)}) — auto-closed: lunch started`, durationSeconds);
        taskInProgress = false;
        taskStartTimestamp = null;
        updateTaskButton();
      }
    }

    let baseNote, durationSeconds = null;

    if (lunchInProgress) {
      baseNote = 'Lunch ended';
      if (lunchStartTimestamp) {
        durationSeconds = Math.round((new Date() - lunchStartTimestamp) / 1000);
        baseNote += ` (${formatDuration(durationSeconds)})`;
      }
    } else {
      baseNote = 'Lunch started';
      lunchStartTimestamp = new Date();
    }

    logEntry('Lunch', baseNote, durationSeconds);

    lunchInProgress = !lunchInProgress;
    if (!lunchInProgress) lunchStartTimestamp = null;
    updateLunchButton();
    updateTotals();
  }

  function updateLunchButton() {
    const btn = document.getElementById('lunchActionBtn');
    if (!btn) return;
    btn.textContent = lunchInProgress ? '▶ End Lunch' : '🍽 Start Lunch';
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
    } else if (lunchInProgress) {
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

  // Given a booking's own entries (already sorted chronologically), figures
  // out whether it's CURRENTLY ongoing or closed. A booking can be started,
  // ended, and reopened more than once — what matters is whichever of
  // those three happened MOST RECENTLY, not just whether an end ever
  // occurred. Used everywhere a booking's open/closed status gets checked,
  // so Reopen behaves consistently across the whole app rather than
  // showing as active in one view and closed in another.
  function getBookingLifecycleStatus(bookingEntries) {
    const lifecycleEvents = bookingEntries.filter(e =>
      /new session started/i.test(e.note || '') ||
      /^session ended/i.test(e.note || '') ||
      /^session reopened/i.test(e.note || '')
    );
    const mostRecent = lifecycleEvents[lifecycleEvents.length - 1];
    const isOngoing = !mostRecent || !/^session ended/i.test(mostRecent.note || '');
    return { isOngoing, endEntry: isOngoing ? null : mostRecent };
  }

  function computeTotalsForEntries(sorted) {
    let totalSeconds = 0;
    let tasksCompleted = 0;
    let totalDowntimeSeconds = 0;
    let totalDeadTimeSeconds = 0;
    let totalSubStateLunchSeconds = 0;

    // Build a lookup of task-number -> start timestamp (in seconds-of-day),
    // taking entries in chronological order so each "started" pairs with
    // the next "completed" for the same task number. Keyed by bookingId so
    // concurrent bookings' interleaved start/end pairs never cross-contaminate
    // each other's duration calculations.
    const openStarts = {};
    const openDowntimeStartByBooking = {};
    const openLunchStartByBooking = {};
    let openDeadTimeStart = null; // Dead Time deliberately stays global — see note in inferTaskNumberFromEntries

    sorted.forEach(e => {
      const note = e.note || '';
      const bk = `${e.bookingId || '__none__'}::${e.operator || '__none__'}`;
      const startMatch = note.match(/task\s+(\d+)\s+started/i);
      const completeMatch = note.match(/task\s+(\d+)\s+(completed|compled)/i);
      const downtimeStartMatch = /downtime\s+started/i.test(note);
      const downtimeEndMatch = /downtime\s+(ended|completed)/i.test(note);
      const lunchStartMatch = e.type === 'Lunch' && /lunch\s+started/i.test(note);
      const lunchEndMatch = e.type === 'Lunch' && /lunch\s+(ended|completed)/i.test(note);
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
      } else if (lunchStartMatch) {
        openLunchStartByBooking[bk] = timeToMinutes(e.timestamp);
      } else if (lunchEndMatch) {
        if (typeof e.durationSeconds === 'number') {
          totalSubStateLunchSeconds += e.durationSeconds;
        } else if (openLunchStartByBooking.hasOwnProperty(bk)) {
          const diff = timeToMinutes(e.timestamp) - openLunchStartByBooking[bk];
          if (diff > 0) totalSubStateLunchSeconds += diff;
        }
        delete openLunchStartByBooking[bk];
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

    // Total Lunch is the sum of whole BOOKINGS whose type is "Lunch"
    // (Lunch is a booking type, not a sub-state within a work booking).
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
    // Combine both sources of lunch time: whole Lunch-type bookings, plus
    // in-booking lunch sub-states (the toggle used while staying attached
    // to an ongoing booking like UC #2).
    totalLunchSeconds += totalSubStateLunchSeconds;

    return { totalSeconds, tasksCompleted, totalDowntimeSeconds, totalLunchSeconds, totalDeadTimeSeconds };
  }

  function updateTotals() {
    const sorted = getViewingEntries().sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
    const { totalSeconds, tasksCompleted, totalDowntimeSeconds, totalLunchSeconds, totalDeadTimeSeconds } = computeTotalsForEntries(sorted);

    // Writes to both the in-card display AND its KPI-bar mirror, so both
    // view modes always stay in sync regardless of which is visible.
    function setBoth(id, text) {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
      const kpiEl = document.getElementById(id + 'Kpi');
      if (kpiEl) kpiEl.textContent = text;
    }

    setBoth('totalActiveDisplay', formatDuration(totalSeconds));
    setBoth('totalDowntimeDisplay', formatDuration(totalDowntimeSeconds));
    setBoth('totalLunchDisplay', formatDuration(totalLunchSeconds));
    setBoth('totalDeadTimeDisplay', formatDuration(totalDeadTimeSeconds));
    updateSessionDuration(sorted);
    setBoth('totalTasksDisplay', tasksCompleted);
    updateCurrentStatusPill();
    renderScheduleList();
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
    function setDisplay(text) {
      const el = document.getElementById('sessionDurationDisplay');
      if (el) el.textContent = text;
      const kpiEl = document.getElementById('sessionDurationDisplayKpi');
      if (kpiEl) kpiEl.textContent = text;
    }
    function setLabel(text) {
      const el = document.getElementById('sessionDurationLabel');
      if (el) el.textContent = text;
      const kpiEl = document.getElementById('sessionDurationLabelKpi');
      if (kpiEl) kpiEl.textContent = text;
    }

    if (!sortedEntries || sortedEntries.length === 0) {
      setDisplay('0m 0s');
      setLabel('Session 1 Duration');
      return;
    }

    // Scope to just THIS device's own booking's entries — with concurrent
    // bookings now possible, someone else starting a completely separate
    // booking must never truncate or reset this device's own duration
    // calculation. Only my own booking's entries count here.
    const myEntries = sortedEntries.filter(e => e.bookingId === myBookingId);

    if (!myBookingId || myEntries.length === 0) {
      setDisplay('0m 0s');
      setLabel('Booking Duration');
      document.getElementById('downtimeAlert').style.display = 'none';
      renderSessionsPanel(sortedEntries);
      return;
    }

    const currentSessionEntries = myEntries;
    setLabel('Current Booking Duration');

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
    setDisplay(formatDuration(diff));

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

  let tickHasRunOnce = false;

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
    // tick()'s own immediate call below happens synchronously at script
    // load time — before later const/let declarations in this file (like
    // OPERATING_HOURS_CUTOFF) have executed, which would throw a temporal
    // dead zone error. initApp() already calls enforceOperatingHoursCutoff()
    // once on load (safely, since it only runs after user interaction, well
    // after the whole script has finished loading) — so it's safe to skip
    // this specific check on tick's very first call and only run it from
    // the second (interval-driven, 1+ second later) call onward.
    if (tickHasRunOnce) {
      const wasPastCutoff = lastOperatingHoursCheck;
      enforceOperatingHoursCutoff();
      if (wasPastCutoff !== lastOperatingHoursCheck) {
        updateDateNavUI();
      }
    }
    tickHasRunOnce = true;
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
    const bigDisplay = document.getElementById('taskProgressElapsedBig');
    const label = document.getElementById('taskProgressLabel');
    const fill = document.getElementById('taskProgressFill');
    if (!label || !fill) return;

    if (bigDisplay) bigDisplay.textContent = formatDuration(elapsedSeconds);

    if (currentTargetMinutes) {
      const targetSeconds = currentTargetMinutes * 60;
      const pct = Math.min(100, Math.round((elapsedSeconds / targetSeconds) * 100));
      fill.style.width = pct + '%';
      fill.classList.toggle('over-target', elapsedSeconds > targetSeconds);
      const remaining = targetSeconds - elapsedSeconds;
      if (bigDisplay) bigDisplay.classList.toggle('over-target', elapsedSeconds > targetSeconds);
      label.textContent = remaining >= 0
        ? `${formatDuration(remaining)} left of ${currentTargetMinutes}m target`
        : `${formatDuration(-remaining)} over the ${currentTargetMinutes}m target`;
    } else {
      fill.style.width = '100%';
      fill.classList.remove('over-target');
      if (bigDisplay) bigDisplay.classList.remove('over-target');
      label.textContent = 'No target set';
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
    const lunchSecs = computeCategorySecondsInSegment(currentSeg, 'lunch');
    const activeSecs = Math.max(0, totalElapsed - downtimeSecs - lunchSecs);

    document.getElementById('segActive').style.width = (activeSecs / totalElapsed * 100) + '%';
    document.getElementById('segDowntime').style.width = (downtimeSecs / totalElapsed * 100) + '%';
    document.getElementById('segLunch').style.width = (lunchSecs / totalElapsed * 100) + '%';
    document.getElementById('sessionProgressOperator').textContent = currentOperator || '—';
    document.getElementById('sessionProgressElapsed').textContent = formatDuration(totalElapsed) + ' elapsed';
  }

  const VIEW_MODE_KEY = 'walden_robot_tracker_view_mode';

  function setViewMode(mode) {
    const kpiBar = document.getElementById('kpiBar');
    const inCardTotals = document.getElementById('inCardTotalsRow');
    const twoColGrid = document.getElementById('twoColGrid');
    const kpiBtn = document.getElementById('viewToggleKpiBtn');
    const gridBtn = document.getElementById('viewToggleGridBtn');
    if (!kpiBar || !twoColGrid) return;

    if (mode === 'grid') {
      kpiBar.style.display = 'none';
      if (inCardTotals) inCardTotals.style.display = 'grid';
      twoColGrid.classList.add('grid-mode');
      if (kpiBtn) kpiBtn.classList.remove('active');
      if (gridBtn) gridBtn.classList.add('active');
    } else {
      mode = 'kpi';
      kpiBar.style.display = 'grid';
      if (inCardTotals) inCardTotals.style.display = 'none';
      twoColGrid.classList.remove('grid-mode');
      if (kpiBtn) kpiBtn.classList.add('active');
      if (gridBtn) gridBtn.classList.remove('active');
    }
    try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch (err) { /* ignore */ }
  }

  function restoreViewMode() {
    let saved = 'kpi';
    try { saved = localStorage.getItem(VIEW_MODE_KEY) || 'kpi'; } catch (err) { /* ignore */ }
    setViewMode(saved);
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
      if (lunchInProgress && lunchStartTimestamp) {
        pausedLunchElapsed = new Date() - lunchStartTimestamp;
        lunchStartTimestamp = null;
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
      if (lunchInProgress && pausedLunchElapsed !== null) {
        lunchStartTimestamp = new Date(new Date() - pausedLunchElapsed);
        pausedLunchElapsed = null;
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

  function logEntry(type, note, durationSeconds, category, bookingIdOverride, overrides) {
    const now = new Date();
    overrides = overrides || {};
    const entry = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      seq: nextSeq++,
      date: overrides.date || now.toLocaleDateString('en-CA'), // YYYY-MM-DD, unambiguous and sortable
      timestamp: overrides.timestamp || now.toLocaleTimeString(undefined, { hour12: true }),
      type: type,
      note: note || '',
      operator: overrides.operator || currentOperator || '',
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
  let bookingOperatorBreakdownOpenFor = null;
  let addEntryFormOpenFor = null;
  let relabelFormOpenFor = null;

  function toggleBookingOperatorBreakdown(bookingId) {
    bookingOperatorBreakdownOpenFor = (bookingOperatorBreakdownOpenFor === bookingId) ? null : bookingId;
    renderLog();
  }

  function toggleAddEntryForm(bookingId) {
    addEntryFormOpenFor = (addEntryFormOpenFor === bookingId) ? null : bookingId;
    renderLog();
  }

  // Adds a brand-new entry to a specific booking — works whether that
  // booking is currently open or already closed, unlike normal logging
  // (Start Run, Start Downtime, etc.) which only works on your own
  // currently-attached booking. This is specifically for backfilling
  // something that was never logged live, or that needs a corrected time.
  function saveNewEntry(bookingId) {
    const type = document.getElementById('addEntryType').value;
    const operator = document.getElementById('addEntryOperator').value;
    const timeVal = document.getElementById('addEntryTime').value;
    const note = document.getElementById('addEntryNote').value.trim();
    if (!timeVal) { showStatus('⚠ Pick a time for the new entry'); return; }
    if (!note) { showStatus('⚠ Enter a note for the new entry'); return; }

    // A Session-type note that looks like "New session started" or "Session
    // reopened" but has no em-dash-separated type after it silently breaks
    // every downstream feature that derives a booking's type from this exact
    // text (tabs, Relabel, Reopen, exports, summaries all show "Unknown"
    // from that point on) — whether the type is missing entirely or someone
    // used a regular hyphen instead of the required em-dash. Catching it
    // here, with a specific fix in the message, is far cheaper than someone
    // discovering it days later as a mystery "Unknown" booking.
    if (type === 'Session' && /(new session started|session reopened)/i.test(note) && !note.includes('—')) {
      showStatus('⚠ Add — (em dash) then the type, e.g. "New session started — UC Data Collect (UC #2)" — otherwise this booking will show as "Unknown" everywhere');
      return;
    }

    const bookingEntries = entries.filter(e => e.bookingId === bookingId);
    const entryDate = bookingEntries.length > 0 ? bookingEntries[0].date : todayDateString();
    const newEntry = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      seq: nextSeq++,
      date: entryDate,
      timestamp: inputTimeToAppTime(timeVal),
      type: type,
      note: note,
      operator: operator,
      category: null,
      durationSeconds: null,
      bookingId: bookingId
    };
    entries.push(newEntry);
    renderLog();
    updateTotals();
    showStatus(`Added manually at ${newEntry.timestamp}`);

    if (supabaseClient) {
      supabaseClient.from('entries').insert(entryToRow(newEntry)).select().single()
        .then(({ data, error }) => {
          if (error) {
            console.warn('New entry sync failed:', error);
            setSyncStatus('offline — new entry not yet synced', 'status-error');
          } else if (data) {
            newEntry.id = data.id;
            renderLog();
          }
        });
    }

    document.getElementById('addEntryNote').value = '';
  }

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
    const reopenBar = document.getElementById('logReopenBar');
    const viewEntries = getViewingEntries();
    document.getElementById('entryCount').textContent = `${viewEntries.length} entr${viewEntries.length === 1 ? 'y' : 'ies'}`;

    if (viewEntries.length === 0) {
      table.style.display = 'none';
      empty.style.display = 'block';
      if (tabBar) tabBar.innerHTML = '';
      if (!isViewingToday()) {
        empty.textContent = "No entries logged on this day.";
      } else if (isPastOperatingHours()) {
        empty.textContent = "No entries were logged today. It's after 6:30 PM — logging resumes tomorrow.";
      } else {
        empty.textContent = "No entries yet — press a button above to start logging.";
      }
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
      let isOngoing = false;
      if (key !== '__unassigned__') {
        // Ongoing status must be checked against the booking's FULL history
        // (every day it touched), not just today's entries — a booking that
        // started yesterday and is still open needs to correctly show as
        // ongoing even when viewing today's slice of its log.
        const fullBookingEntries = entries.filter(e => e.bookingId === key);
        const info = getBookingLifecycleInfo(fullBookingEntries);
        isOngoing = info.isOngoing;
        const idSuffix = info.ucNumber ? ` (UC #${info.ucNumber})` : info.policyNumber ? ` (Policy #${info.policyNumber})` : info.hbTaskNumber ? ` (Task #${info.hbTaskNumber})` : '';
        const operators = [...new Set(groupEntries.map(e => e.operator).filter(Boolean))];
        const first = groupEntries[groupEntries.length - 1].timestamp;
        const last = groupEntries[0].timestamp;
        title = `${info.type}${idSuffix}`;
        meta = `${escapeHtml(operators.join(', ') || '—')} — ${first} to ${last} — ${groupEntries.length} ${groupEntries.length === 1 ? 'entry' : 'entries'}`;
      } else {
        meta = `${groupEntries.length} ${groupEntries.length === 1 ? 'entry' : 'entries'}`;
      }

      return { key, groupEntries, mostRecentSortVal, title, meta, isOngoing };
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

    if (reopenBar) {
      const singleGroup = (currentLogTabFilter !== '__all__' && currentLogTabFilter !== '__unassigned__') ? visibleGroups[0] : null;
      reopenBar.style.display = singleGroup ? 'flex' : 'none';
      if (singleGroup) {
        const statusText = singleGroup.isOngoing ? 'This booking is open' : 'This booking is closed';
        const reopenBtn = singleGroup.isOngoing ? '' : `<button onclick="reopenBooking('${singleGroup.key}')">↩ Reopen This Booking</button>`;
        reopenBar.innerHTML = `
          <span>${statusText} — ${escapeHtml(singleGroup.title)}</span>
          <span class="log-reopen-bar-actions">
            <button class="secondary" onclick="relabelBooking('${singleGroup.key}')">Relabel</button>
            <button class="secondary" onclick="toggleBookingOperatorBreakdown('${singleGroup.key}')" id="opBreakdownToggleBtn">By Operator</button>
            <button class="secondary" onclick="toggleAddEntryForm('${singleGroup.key}')">+ Add Entry</button>
            ${reopenBtn}
          </span>
        `;
      }
    }

    const opBreakdownBar = document.getElementById('logOperatorBreakdown');
    if (opBreakdownBar) {
      const singleGroup = (currentLogTabFilter !== '__all__' && currentLogTabFilter !== '__unassigned__') ? visibleGroups[0] : null;
      if (!singleGroup || bookingOperatorBreakdownOpenFor !== singleGroup.key) {
        opBreakdownBar.style.display = 'none';
      } else {
        // Reuses computeOperatorStats exactly as-is, just scoped to this
        // one booking's own entries instead of the whole day — same
        // Active/Downtime/Downtime% shape already used in Generate Summary,
        // so the numbers here always mean the same thing they do there.
        const allBookingEntries = entries.filter(e => e.bookingId === singleGroup.key)
          .sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
        const stats = computeOperatorStats(allBookingEntries);
        opBreakdownBar.style.display = 'block';
        opBreakdownBar.innerHTML = stats.length === 0 ? '<div class="schedule-empty">No task or downtime activity logged yet.</div>' : `
          <table class="op-breakdown-table">
            <thead><tr><th>Operator</th><th>Active</th><th>Downtime</th><th>Downtime %</th></tr></thead>
            <tbody>${stats.map(s => `<tr><td>${escapeHtml(s.operator)}</td><td>${s.active}</td><td>${s.downtime}</td><td>${s.downtimePct}%</td></tr>`).join('')}</tbody>
          </table>
        `;
      }
    }

    const addEntryBar = document.getElementById('logAddEntryForm');
    if (addEntryBar) {
      const singleGroup = (currentLogTabFilter !== '__all__' && currentLogTabFilter !== '__unassigned__') ? visibleGroups[0] : null;
      if (!singleGroup || addEntryFormOpenFor !== singleGroup.key) {
        addEntryBar.style.display = 'none';
      } else {
        addEntryBar.style.display = 'block';
        addEntryBar.innerHTML = `
          <div class="add-entry-form">
            <select id="addEntryType">
              <option value="Active">Task (Active)</option>
              <option value="Downtime">Downtime</option>
              <option value="Session">Session</option>
              <option value="Lunch">Lunch</option>
              <option value="DeadTime">Dead Time</option>
            </select>
            <select id="addEntryOperator">${Array.from(document.getElementById('operatorSelect').options).map(o => o.value).filter(v => v !== 'Other').map(n => `<option value="${escapeAttr(n)}" ${n === currentOperator ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}</select>
            <input type="time" step="1" id="addEntryTime" value="${appTimeToInputTime(new Date().toLocaleTimeString(undefined, { hour12: true }))}" />
            <input type="text" id="addEntryNote" placeholder="Note, e.g. Task 4 started" />
            <button onclick="saveNewEntry('${singleGroup.key}')">+ Add</button>
          </div>
        `;
      }
    }

    const relabelBar = document.getElementById('logRelabelForm');
    if (relabelBar) {
      const singleGroup = (currentLogTabFilter !== '__all__' && currentLogTabFilter !== '__unassigned__') ? visibleGroups[0] : null;
      if (!singleGroup || relabelFormOpenFor !== singleGroup.key) {
        relabelBar.style.display = 'none';
      } else {
        relabelBar.style.display = 'block';
        relabelBar.innerHTML = `
          <div class="add-entry-form">
            <select id="relabelTypeSelect" onchange="handleRelabelTypeChange()">
              <option value="Sim Data Collect">Sim Data Collect</option>
              <option value="UC Data Collect">UC Data Collect</option>
              <option value="Targeted Data Collect">Targeted Data Collect</option>
              <option value="Policy Training">Policy Training</option>
              <option value="Lunch">Lunch</option>
              <option value="Household Bridge Data Collection">Household Bridge Data Collection</option>
              <option value="Other">Other...</option>
            </select>
            <input type="text" id="relabelOtherInput" placeholder="Describe the type" style="display:none;" />
            <div class="target-row" id="relabelNumberRow" style="display:none;">
              <label id="relabelNumberLabel" for="relabelNumberInput">UC #</label>
              <input type="number" id="relabelNumberInput" min="1" />
            </div>
            <button onclick="submitRelabelForm('${singleGroup.key}')">Save Relabel</button>
            <button class="secondary" onclick="cancelRelabelForm()">Cancel</button>
          </div>
        `;
      }
    }

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
        <td class="time-cell">${e.timestamp}</td>
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
    const timeCell = row.querySelector('.time-cell') || row.children[1];
    timeCell.innerHTML = `<input type="time" step="1" class="edit-time-input" value="${appTimeToInputTime(entry.timestamp)}" />`;
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
    const timeInput = row.querySelector('.edit-time-input');
    const entry = entries.find(x => x.id === id);
    if (entry) {
      const newNote = input.value.trim();
      // The same risk "+ Add Entry" already guards against: if this entry
      // currently reads as a real "New session started" or "Session
      // reopened" marker (the two patterns everything else parses a
      // booking's identity from), and the edit would strip out the
      // em-dash-separated type, the booking silently becomes "Unknown" —
      // even if someone only meant to fix a typo or the time. The Edit
      // button has no validation otherwise, and it sits on every row,
      // including this specific one.
      const wasLifecycleMarker = entry.type === 'Session' && /(new session started|session reopened)/i.test(entry.note || '') && (entry.note || '').includes('—');
      const stillHasMarkerPhrase = /(new session started|session reopened)/i.test(newNote);
      if (wasLifecycleMarker && (!newNote.includes('—') || !stillHasMarkerPhrase)) {
        showStatus('⚠ Keep the — (em dash) and the type in this note, e.g. "New session started — UC Data Collect (UC #1)" — removing it will make this booking show as "Unknown" everywhere');
        return;
      }
      entry.note = newNote;
      const updates = { note: entry.note };
      if (timeInput && timeInput.value) {
        entry.timestamp = inputTimeToAppTime(timeInput.value);
        updates.entry_time = entry.timestamp;
      }
      showStatus(`Entry updated for ${entry.timestamp}`);
      if (supabaseClient && !String(id).startsWith('local_')) {
        supabaseClient.from('entries').update(updates).eq('id', id)
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

  // 6:30 PM local time cutoff — after this, today becomes read-only, same
  // as browsing a past date. Uses each device's own local clock, matching
  // how every other timestamp in this app already works. Cutoff values are
  // inlined directly (not a separately-declared const) so this function is
  // always safe to call no matter how early — including from tick()'s own
  // immediate synchronous call at script load time, before this point in
  // the file would otherwise have executed yet.
  function isPastOperatingHours() {
    const now = new Date();
    const cutoffMinutes = 18 * 60 + 30;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return nowMinutes >= cutoffMinutes;
  }
  // A separate passcode from the main team login, letting someone
  // authorized (e.g. a supervisor approving legitimate late work) bypass
  // the 6:30 cutoff for the rest of today, on this device only.
  // CHANGE THIS to whatever code your team wants — it's a plain client-side
  // string, not a real secret, so treat it the same as a soft door code,
  // not a security boundary.
  const AFTER_HOURS_OVERRIDE_CODE = 'OVERRIDE2026';
  const AFTER_HOURS_OVERRIDE_KEY = 'walden_robot_tracker_after_hours_override';

  function isAfterHoursOverrideActive() {
    try {
      // Keyed to today's date specifically, so leaving a tab open overnight
      // doesn't silently carry an old override into a brand new day.
      return sessionStorage.getItem(AFTER_HOURS_OVERRIDE_KEY) === todayDateString();
    } catch (err) {
      return false;
    }
  }

  function submitAfterHoursOverride() {
    const input = document.getElementById('afterHoursOverrideInput');
    const errorEl = document.getElementById('afterHoursOverrideError');
    if (!input) return;
    if (input.value === AFTER_HOURS_OVERRIDE_CODE) {
      try { sessionStorage.setItem(AFTER_HOURS_OVERRIDE_KEY, todayDateString()); } catch (err) { /* ignore */ }
      input.value = '';
      if (errorEl) errorEl.textContent = '';
      updateDateNavUI();
      updateWorkControlsGating();
      showStatus('After-hours override active — logging unlocked for the rest of today');
    } else {
      if (errorEl) errorEl.textContent = 'Incorrect code';
    }
  }

  function canLogRightNow() {
    return isViewingToday() && (!isPastOperatingHours() || isAfterHoursOverrideActive());
  }

  // Force-ends any booking still open once the cutoff passes. Runs from any
  // device that has the app open — not just the booking's own owner —
  // since the goal is that every booking is closed by 6:30, regardless of
  // whose tab happens to notice first. For this device's OWN attached
  // booking, any in-progress task/downtime gets cleanly auto-closed first
  // (we have the local state to do that correctly). For OTHER people's
  // still-open bookings found via the shared active-bookings list, we
  // close the booking itself without trying to close their sub-timers —
  // no local visibility into their state, and an unclosed task/downtime
  // entry is already a tolerated edge case elsewhere in this app.
  let lastOperatingHoursCheck = null;
  function enforceOperatingHoursCutoff() {
    if (!isPastOperatingHours()) { lastOperatingHoursCheck = false; return; }
    lastOperatingHoursCheck = true;
    const myOverrideActive = isAfterHoursOverrideActive();

    // My own override only protects MY OWN booking — it says nothing about
    // whether anyone else's booking also has a valid override, so this
    // device still helps close everyone else's still-open bookings below.
    if (myBookingId && !myOverrideActive) {
      if (taskInProgress) {
        const durationSeconds = taskStartTimestamp ? Math.round((new Date() - taskStartTimestamp) / 1000) : 0;
        logEntry('Active', `Task ${currentTaskNumber} completed (${formatDuration(durationSeconds)}) — auto-closed: end of day`, durationSeconds);
        taskInProgress = false;
        taskStartTimestamp = null;
        updateTaskButton();
      }
      if (downtimeInProgress) {
        autoCloseDowntime('end of day');
      }
      const idSuffix = currentUcNumber ? ` (UC #${currentUcNumber})` : currentPolicyNumber ? ` (Policy #${currentPolicyNumber})` : currentHbTaskNumber ? ` (Task #${currentHbTaskNumber})` : '';
      logEntry('Session', `Session ended — ${mainSessionType}${idSuffix} — auto-ended: end of day`, null, null, myBookingId);
      detachFromMyBooking();
      showStatus('Booking auto-ended — 6:30 PM cutoff reached');
    }

    // Sweep any other still-open bookings this device can see, regardless
    // of owner, so the rule holds even if the owner's own tab is closed.
    // Excludes my own booking specifically when my override is active —
    // otherwise this sweep would immediately re-close the very booking
    // the block above just protected, since it has no other awareness of
    // which booking is "mine."
    const stillActive = computeActiveBookings().filter(b => !(myOverrideActive && b.bookingId === myBookingId));
    stillActive.forEach(b => {
      const idSuffix = b.ucNumber ? ` (UC #${b.ucNumber})` : b.policyNumber ? ` (Policy #${b.policyNumber})` : b.hbTaskNumber ? ` (Task #${b.hbTaskNumber})` : '';
      logEntry('Session', `Session ended — ${b.type}${idSuffix} — auto-ended: end of day`, null, null, b.bookingId);
    });
    if (stillActive.length > 0) renderActiveBookingsList();
  }

  function updateDateNavUI() {
    const today = todayDateString();
    const label = document.getElementById('dateNavLabel');
    const dateInput = document.getElementById('viewingDateInput');
    const todayBtn = document.getElementById('dateNavTodayBtn');
    const banner = document.getElementById('historyBanner');
    const afterHoursBanner = document.getElementById('afterHoursBanner');

    dateInput.value = viewingDate;

    if (viewingDate === today) {
      label.textContent = 'Today';
      label.classList.remove('is-history');
      todayBtn.style.display = 'none';
      banner.style.display = 'none';
      if (afterHoursBanner) {
        afterHoursBanner.style.display = isPastOperatingHours() ? 'flex' : 'none';
        const lockedState = document.getElementById('afterHoursLockedState');
        const activeState = document.getElementById('afterHoursOverrideActiveState');
        const overridden = isAfterHoursOverrideActive();
        if (lockedState) lockedState.style.display = overridden ? 'none' : 'block';
        if (activeState) activeState.style.display = overridden ? 'block' : 'none';
      }
    } else {
      const d = new Date(viewingDate + 'T00:00:00');
      label.textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      label.classList.add('is-history');
      todayBtn.style.display = 'inline-block';
      banner.style.display = 'flex';
      if (afterHoursBanner) afterHoursBanner.style.display = 'none';
    }

    setActionControlsEnabled(canLogRightNow());
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

  // Converts between the app's stored "2:30:45 PM" format and the native
  // <input type="time" step="1"> format ("14:30:45"), so timestamps can be
  // edited with a real time picker instead of typing free text that has
  // to exactly match the app's own format.
  function appTimeToInputTime(appTimestamp) {
    const d = parseTimestampToDate(appTimestamp);
    if (!d) return '00:00:00';
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function inputTimeToAppTime(inputValue) {
    const parts = inputValue.split(':').map(Number);
    const h24 = parts[0], m = parts[1], s = parts[2] || 0;
    const ampm = h24 >= 12 ? 'PM' : 'AM';
    let h12 = h24 % 12; if (h12 === 0) h12 = 12;
    return `${h12}:${pad(m)}:${pad(s)} ${ampm}`;
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
        // Prefer the entry's own numeric durationSeconds — reliable
        // regardless of length. The regex fallback below only matches
        // "Xm Ys" and silently mis-parses anything an hour or longer
        // (e.g. "1h 5m 2s"), which is why durationSeconds is checked first.
        let duration;
        if (typeof e.durationSeconds === 'number') {
          duration = formatDuration(e.durationSeconds);
        } else {
          const dm = note.match(/\((?:(\d+)h\s+)?(\d+)m\s+(\d+)s\)/);
          duration = dm ? formatDuration((parseInt(dm[1] || '0', 10) * 3600) + (parseInt(dm[2], 10) * 60) + parseInt(dm[3], 10)) : '?';
        }
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

  // Sums each individual active period for a booking (start-to-end, or
  // reopen-to-end) rather than treating "first entry to last entry" as one
  // continuous span. A booking that was left/ended and later reopened has
  // a real gap in between — counting that gap as part of the duration
  // would overstate it, sometimes dramatically if the reopen happened
  // hours or days later.
  function computeBookingActiveSpanSeconds(seg) {
    const lifecycleEvents = seg.filter(e => e.type === 'Session' && (
      /new session started/i.test(e.note || '') ||
      /^session ended/i.test(e.note || '') ||
      /^session reopened/i.test(e.note || '')
    ));
    let total = 0;
    let openStart = null;
    lifecycleEvents.forEach(e => {
      const isOpen = /new session started/i.test(e.note || '') || /^session reopened/i.test(e.note || '');
      const isClose = /^session ended/i.test(e.note || '');
      if (isOpen) {
        openStart = timeToMinutes(e.timestamp);
      } else if (isClose && openStart !== null) {
        let diff = timeToMinutes(e.timestamp) - openStart;
        if (diff < 0) diff += 24 * 3600;
        total += diff;
        openStart = null;
      }
    });
    if (openStart !== null) {
      // Still open right now — count up to the current moment.
      const now = new Date();
      const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      let diff = nowSeconds - openStart;
      if (diff < 0) diff += 24 * 3600;
      total += diff;
    }
    return total;
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
    const perBooking = bookingIds.map(id => {
      const seg = byBooking[id].sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
      const startTs = seg[0].timestamp;
      const lastTs = seg[seg.length - 1].timestamp;
      const info = getBookingLifecycleInfo(seg);
      const isOngoing = info.isOngoing;
      const downtimeSecs = computeCategorySecondsInSegment(seg, 'downtime');

      // Sum each active period rather than a naive first-to-last span —
      // this is what correctly combines a booking that was left/ended and
      // later reopened into one accurate total, instead of counting the
      // gap in between as if it were active time.
      let withDowntime = computeBookingActiveSpanSeconds(seg);
      if (withDowntime < 0) withDowntime = 0;
      let withoutDowntime = withDowntime - downtimeSecs;
      if (withoutDowntime < 0) withoutDowntime = 0;

      const idSuffix = info.ucNumber ? ` (UC #${info.ucNumber})` : info.policyNumber ? ` (Policy #${info.policyNumber})` : info.hbTaskNumber ? ` (Task #${info.hbTaskNumber})` : '';
      const operators = [...new Set(seg.map(e => e.operator).filter(Boolean))];
      return {
        name: `${info.type}${idSuffix}`,
        operators,
        startSortVal: entrySortValue(seg[0]),
        endSortVal: entrySortValue(seg[seg.length - 1]),
        start: startTs,
        end: isOngoing ? 'ongoing' : lastTs,
        isOngoing,
        durationWithDowntimeSeconds: withDowntime,
        durationWithoutDowntimeSeconds: withoutDowntime,
        downtimeSeconds: downtimeSecs,
        gaps: computeUnaccountedGaps(seg)
      };
    });

    // Two separate bookings can share the same name — the same UC # started
    // twice on the same day by different people, say. Those should read as
    // one combined line in the report, not two disconnected "sessions".
    const byName = {};
    perBooking.forEach(b => {
      if (!byName[b.name]) byName[b.name] = [];
      byName[b.name].push(b);
    });

    const combined = Object.keys(byName).map(name => {
      const group = byName[name];
      const withDowntime = group.reduce((sum, b) => sum + b.durationWithDowntimeSeconds, 0);
      const withoutDowntime = group.reduce((sum, b) => sum + b.durationWithoutDowntimeSeconds, 0);
      const downtimeSecs = group.reduce((sum, b) => sum + b.downtimeSeconds, 0);
      const operators = [...new Set(group.flatMap(b => b.operators))];
      const earliest = group.reduce((a, b) => a.startSortVal <= b.startSortVal ? a : b);
      const latest = group.reduce((a, b) => a.endSortVal >= b.endSortVal ? a : b);
      const anyOngoing = group.some(b => b.isOngoing);
      const gaps = group.flatMap(b => b.gaps);
      return {
        name,
        sortVal: earliest.startSortVal,
        operators: operators.join(', ') || '—',
        start: earliest.start,
        end: anyOngoing ? 'ongoing' : latest.end,
        durationWithDowntimeSeconds: withDowntime,
        durationWithoutDowntimeSeconds: withoutDowntime,
        downtimeSeconds: downtimeSecs,
        durationWithDowntime: formatDuration(withDowntime),
        durationWithoutDowntime: formatDuration(withoutDowntime),
        downtimeDuration: formatDuration(downtimeSecs),
        gaps,
        get unaccountedSeconds() { return this.gaps.reduce((sum, g) => sum + g.seconds, 0); }
      };
    });

    return combined.sort((a, b) => a.sortVal - b.sortVal);
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

  function generateSummaryDoc(customEntries, customLabel) {
    const viewEntries = customEntries || getViewingEntries();
    if (viewEntries.length === 0) {
      showStatus(customEntries ? 'Nothing to summarize in the selected sessions' : `Nothing to summarize for ${formatDateShort(viewingDate)}`);
      return;
    }
    const sorted = viewEntries.slice().sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
    const operators = [...new Set(sorted.map(e => e.operator).filter(Boolean))];

    // Compute headline stats directly from the entries being summarized —
    // never from the live DOM totals, which always reflect today's whole
    // day regardless of what's actually being summarized here.
    const totals = computeTotalsForEntries(sorted);
    const tasksCompleted = totals.tasksCompleted;
    const activeTime = formatDuration(totals.totalSeconds);
    const downtimeTime = formatDuration(totals.totalDowntimeSeconds);
    const lunchTime = formatDuration(totals.totalLunchSeconds);
    const deadTime = formatDuration(totals.totalDeadTimeSeconds);

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

    const dateStr = customLabel || new Date(viewingDate + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const summaryFilename = customEntries ? `robot_use_summary_selected_sessions.html` : `robot_use_summary_${viewingDate}.html`;

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

  <h2>Booking Breakdown</h2>
  <table>
    <tr><th>Booking</th><th>Operator(s)</th><th>Start</th><th>End</th><th>Time (incl. downtime)</th><th>Time (excl. downtime)</th><th>Downtime</th><th>Unaccounted</th></tr>
    ${sessionSummaries.map(s => `<tr><td>${escapeHtmlText(s.name)}</td><td>${escapeHtmlText(s.operators)}</td><td>${s.start}</td><td>${s.end}</td><td>${s.durationWithDowntime}</td><td>${s.durationWithoutDowntime}</td><td>${s.downtimeDuration}</td><td>${formatDuration(s.unaccountedSeconds)}</td></tr>`).join('')}
  </table>

  ${sessionSummaries.some(s => s.gaps.length > 0) ? `<h2>Unaccounted Time Gaps</h2>
  <p style="color:#6b7280;font-size:13px;">Time between logged events that wasn't recorded as active work, downtime, or lunch.</p>
  <table>
    <tr><th>Booking</th><th>From</th><th>To</th><th>Duration</th></tr>
    ${sessionSummaries.flatMap(s => s.gaps.map(g => `<tr><td>${escapeHtmlText(s.name)}</td><td>${g.startLabel}</td><td>${g.endLabel}</td><td>${formatDuration(g.seconds)}</td></tr>`)).join('')}
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
      const info = getBookingLifecycleInfo(seg);

      const operators = [...new Set(seg.map(e => e.operator).filter(Boolean))];
      const sorted = seg.slice().sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));

      return {
        id: bookingId,
        index: i + 1,
        type: info.type,
        policyNumber: info.ucNumber ? null : info.policyNumber,
        ucNumber: info.ucNumber,
        hbTaskNumber: info.hbTaskNumber,
        operators: operators.join(', ') || '—',
        startDate: sorted[0].date,
        startTime: sorted[0].timestamp,
        endDate: sorted[sorted.length - 1].date,
        endTime: sorted[sorted.length - 1].timestamp,
        ongoing: info.isOngoing,
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
    const summaryBtn = document.getElementById('summarizeSelectedSessionsBtn');
    if (summaryBtn) summaryBtn.textContent = `📄 Generate Summary for Selected (${checked.length})`;
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

  function generateSummaryForSelectedSessions() {
    const checked = Array.from(document.querySelectorAll('#sessionExportList input[type="checkbox"]:checked'));
    if (checked.length === 0) {
      showStatus('⚠ Check at least one session to summarize');
      return;
    }
    const sessions = computeAllSessions();
    const selectedIds = new Set(checked.map(cb => cb.value));
    const selectedSessions = sessions.filter(s => selectedIds.has(s.id));
    const selectedEntries = selectedSessions.flatMap(s => s.entries);

    // Build a readable label spanning whatever dates the selected sessions
    // actually cover, since selections can span the whole history, not
    // just a single day like the regular "Generate Summary" button.
    const dates = [...new Set(selectedEntries.map(e => e.date).filter(Boolean))].sort();
    let label;
    if (dates.length === 0) {
      label = `${selectedSessions.length} Selected Session${selectedSessions.length === 1 ? '' : 's'}`;
    } else if (dates.length === 1) {
      const d = new Date(dates[0] + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      label = `${d} — ${selectedSessions.length} Selected Session${selectedSessions.length === 1 ? '' : 's'}`;
    } else {
      label = `${formatDateShort(dates[0])} to ${formatDateShort(dates[dates.length - 1])} — ${selectedSessions.length} Selected Sessions`;
    }

    generateSummaryDoc(selectedEntries, label);
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
        currentHbTaskNumber = stillActive.hbTaskNumber ? parseInt(stillActive.hbTaskNumber, 10) : null;
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

    // Lunch sub-state — scoped to MY booking AND operator, exactly like
    // Downtime above. This scoping is what prevents the original bug
    // (one person's lunch getting auto-closed by a DIFFERENT person's task
    // start, when multiple operators share one booking) from coming back.
    const lunchEvents = getTodayEntries()
      .filter(e => e.type === 'Lunch' && e.bookingId === myBookingId && e.operator === currentOperator)
      .slice()
      .sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
    if (lunchEvents.length > 0) {
      const last = lunchEvents[lunchEvents.length - 1];
      lunchInProgress = /started/i.test(last.note || '');
      lunchStartTimestamp = lunchInProgress ? parseTimestampToDate(last.timestamp) : null;
    } else {
      lunchInProgress = false;
      lunchStartTimestamp = null;
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
    const ucHint = document.getElementById('ucNumberHint');
    const policyRow = document.getElementById('policyNumberRow');
    const hbTaskRow = document.getElementById('hbTaskNumberRow');
    const hbTargetRow = document.getElementById('hbTargetHoursRow');
    const needsUcNumber = (select.value === 'UC Data Collect' || select.value === 'Targeted Data Collect');
    otherInput.style.display = (select.value === 'Other') ? 'block' : 'none';
    ucRow.style.display = needsUcNumber ? 'flex' : 'none';
    if (ucHint) ucHint.textContent = `(required for ${select.value})`;
    policyRow.style.display = (select.value === 'Policy Training') ? 'flex' : 'none';
    hbTaskRow.style.display = (select.value === 'Household Bridge Data Collection') ? 'flex' : 'none';
    hbTargetRow.style.display = 'none';
    document.getElementById('hbTaskNumberInput').value = '';
    document.getElementById('hbTargetHoursInput').value = '';
  }

  // Looks across ALL history (not just today) for a prior Household Bridge
  // booking with this exact task number, to find whatever target hours was
  // set the first time this task was ever started — mirrors how UC#/Policy#
  // get embedded directly in the note rather than needing a separate table.
  function findHbTaskTarget(taskNumber) {
    const pattern = new RegExp(`—\\s*Household Bridge Data Collection\\s*\\(Task #${taskNumber}, Target: ([\\d.]+)h\\)`, 'i');
    for (const e of entries) {
      if (e.type !== 'Session') continue;
      const m = (e.note || '').match(pattern);
      if (m) return parseFloat(m[1]);
    }
    return null;
  }

  function handleHbTaskNumberChange() {
    const taskInput = document.getElementById('hbTaskNumberInput');
    const targetRow = document.getElementById('hbTargetHoursRow');
    const taskNum = parseInt(taskInput.value, 10);
    if (!taskNum || taskNum < 1) {
      targetRow.style.display = 'none';
      return;
    }
    const existingTarget = findHbTaskTarget(taskNum);
    if (existingTarget === null) {
      // First time this task number has ever been started — need a goal.
      targetRow.style.display = 'flex';
    } else {
      targetRow.style.display = 'none';
      const progress = computeHbTaskProgress(taskNum, existingTarget);
      showStatus(`Task #${taskNum}: ${formatDuration(progress.accumulatedSeconds)} of ${existingTarget}h collected so far`);
    }
  }

  // Sums accumulated Run Time (task timer active seconds) across EVERY
  // Household Bridge booking ever logged with this task number, regardless
  // of date — this is a multi-session, multi-day cumulative goal, not a
  // single-sitting one.
  function computeHbTaskProgress(taskNumber, targetHoursOverride) {
    const bookingIds = new Set();
    const pattern = new RegExp(`Household Bridge Data Collection\\s*\\(Task #${taskNumber}`, 'i');
    entries.forEach(e => {
      if (e.type === 'Session' && e.bookingId && pattern.test(e.note || '')) {
        bookingIds.add(e.bookingId);
      }
    });
    const relevantEntries = entries.filter(e => bookingIds.has(e.bookingId));
    const totals = computeTotalsForEntries(relevantEntries.slice().sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq)));
    const target = (typeof targetHoursOverride === 'number') ? targetHoursOverride : (findHbTaskTarget(taskNumber) || 0);
    return {
      accumulatedSeconds: totals.totalSeconds,
      accumulatedHours: totals.totalSeconds / 3600,
      targetHours: target
    };
  }

  // ---- Today's Schedule ----
  // Lets someone plan the day's targets manually (type + number + target
  // hours) each morning, editable anytime after. Stored as plain entries
  // (type 'ScheduleTarget') so no new Supabase table or migration is
  // needed — same approach as everything else in this app.
  function getTodaysScheduleItems() {
    return entries
      .filter(e => e.type === 'ScheduleTarget' && e.date === todayDateString())
      .sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
  }

  function parseScheduleItem(e) {
    const m = (e.note || '').match(/^Scheduled — (.+?)(?:\s*\((UC|Policy|Task) #(\d+)\))?\s*—\s*Target:\s*([\d.]+)h$/);
    if (!m) return null;
    return {
      id: e.id,
      type: m[1].trim(),
      numberKind: m[2] || null,
      number: m[3] || null,
      targetHours: parseFloat(m[4])
    };
  }

  function addScheduleItem(suffix) {
    suffix = suffix || '';
    const typeSelect = document.getElementById('scheduleTypeSelect' + suffix);
    const numberInput = document.getElementById('scheduleNumberInput' + suffix);
    const targetInput = document.getElementById('scheduleTargetInput' + suffix);
    const type = typeSelect.value;
    if (!type) { showStatus('⚠ Pick a type for the schedule item'); return; }

    // Policy Training's number is optional everywhere else in the app real
    // bookings can start without one — the schedule shouldn't be stricter
    // than the thing it's tracking. UC/Targeted/Household Bridge genuinely
    // require one, since that number is what identifies which one it is.
    const requiresNumber = (type === 'UC Data Collect' || type === 'Targeted Data Collect' || type === 'Household Bridge Data Collection');
    const allowsNumber = requiresNumber || type === 'Policy Training';
    const numberKind = (type === 'Policy Training') ? 'Policy' : (type === 'Household Bridge Data Collection') ? 'Task' : 'UC';
    const num = parseInt(numberInput.value, 10);
    if (requiresNumber && (!num || num < 1)) {
      showStatus(`⚠ Enter a number for ${type} before adding it to the schedule`);
      numberInput.focus();
      return;
    }
    const target = parseFloat(targetInput.value);
    if (!target || target <= 0) {
      showStatus('⚠ Enter a target in hours before adding it to the schedule');
      targetInput.focus();
      return;
    }

    const hasNumber = allowsNumber && num > 0;
    const numSuffix = hasNumber ? ` (${numberKind} #${num})` : '';
    const note = `Scheduled — ${type}${numSuffix} — Target: ${target}h`;
    logEntry('ScheduleTarget', note, null, null, null);
    numberInput.value = '';
    targetInput.value = '';
    renderScheduleList();
    showStatus(`Added ${type}${numSuffix} to today's schedule`);
  }

  function addScheduleItemCard() { addScheduleItem('Card'); }

  function toggleScheduleCard() {
    const body = document.getElementById('scheduleCardBody');
    const toggle = document.getElementById('scheduleCardToggle');
    const collapsed = body.style.display === 'none';
    body.style.display = collapsed ? 'block' : 'none';
    toggle.textContent = collapsed ? '▾ hide' : '▸ show';
  }

  function removeScheduleItem(entryId) {
    entries = entries.filter(e => e.id !== entryId);
    if (supabaseClient && !String(entryId).startsWith('local_')) {
      supabaseClient.from('entries').delete().eq('id', entryId)
        .then(({ error }) => { if (error) console.warn('Schedule item delete sync failed:', error); });
    }
    renderScheduleList();
    showStatus('Removed from today\u2019s schedule');
  }

  // Sums actual collected time today for whatever bookings match this
  // schedule item's type+number — same "match by type and number, sum
  // active time across every matching booking" approach already proven
  // correct for Household Bridge, generalized here to any type.
  function computeScheduleItemProgress(item) {
    // When the schedule item has a specific number, only that exact number
    // counts (UC #2's target shouldn't absorb UC #5's work). When it has no
    // number at all (a generic "Policy Training" target, say), it should
    // match ANY booking of that type today, whether or not that particular
    // booking happened to have its own number attached — otherwise a
    // numberless schedule item would only match a booking whose note is
    // an exact, suffix-less string, missing real work that had a number.
    // numberKind is derived from the type here rather than trusted from
    // item.numberKind, since that field is null whenever no number was
    // given when the item was created (nothing to parse it from) — using
    // it directly in the fallback pattern would literally search for the
    // word "null" instead of "Policy".
    const derivedNumberKind = item.numberKind || (item.type === 'Policy Training' ? 'Policy' : (item.type === 'Household Bridge Data Collection' ? 'Task' : 'UC'));
    const numberPattern = item.number
      ? `\\s*\\(${derivedNumberKind} #${item.number}\\)`
      : `(?:\\s*\\(${derivedNumberKind} #\\d+\\))?`;
    const pattern = new RegExp(`^${item.type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${numberPattern}\\s*$`, 'i');
    const bookingIds = new Set();
    entries.forEach(e => {
      if (e.type !== 'Session' || !e.bookingId || e.date !== todayDateString()) return;
      if (!/new session started/i.test(e.note || '')) return;
      const afterDash = (e.note || '').split('—')[1];
      if (afterDash && pattern.test(afterDash.trim())) bookingIds.add(e.bookingId);
    });

    // Tracks the booking's own span minus downtime — not Run Time button
    // usage specifically. A team may not click Start Run for every moment
    // of real work, but a booking's start-to-end already reflects when the
    // robot was actually in use for this task, so that's the number that
    // should count toward the schedule. Reuses computeBookingActiveSpanSeconds
    // (built for combining Leave/Reopen cycles in the summary report) so a
    // booking that was ended and reopened later doesn't count the gap
    // in between as if it were collection time.
    let totalSeconds = 0;
    bookingIds.forEach(bid => {
      const bookingEntries = entries.filter(e => e.bookingId === bid)
        .sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
      const span = computeBookingActiveSpanSeconds(bookingEntries);
      const downtime = computeCategorySecondsInSegment(bookingEntries, 'downtime');
      totalSeconds += Math.max(0, span - downtime);
    });

    return {
      accumulatedSeconds: totalSeconds,
      accumulatedHours: totalSeconds / 3600,
      targetHours: item.targetHours
    };
  }

  function updateWorkControlsGating() {
    // Run Time / Downtime only make sense once THIS device is attached to
    // a booking, AND only during operating hours today (not browsing
    // read-only history, and not after the 6:30 PM cutoff) — this is the
    // "order of operations" enforcement.
    const enabled = !sessionEnded && canLogRightNow();
    ['taskActionBtn', 'downtimeActionBtn', 'lunchActionBtn'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      const isMidAction = (id === 'taskActionBtn' && taskInProgress) ||
                           (id === 'downtimeActionBtn' && downtimeInProgress) ||
                           (id === 'lunchActionBtn' && lunchInProgress);
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

  // Single source of truth for "is this booking currently open, and what
  // is it." A booking can be started, ended, and reopened more than once —
  // what determines current status is whichever of those three most
  // recently happened, never just "has an ended entry ever occurred."
  // Every function that needs booking status or its type/UC#/Policy#/Task#
  // should call this rather than re-deriving it, so a fix or a new
  // lifecycle event (like Reopen) only has to be taught in one place.
  function getBookingLifecycleInfo(bookingEntries) {
    const seg = bookingEntries.slice().sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
    const startEntry = seg.find(e => e.type === 'Session' && /new session started/i.test(e.note || ''));

    const lifecycleEvents = seg.filter(e => e.type === 'Session' && (
      /new session started/i.test(e.note || '') ||
      /^session ended/i.test(e.note || '') ||
      /^session reopened/i.test(e.note || '')
    ));
    const mostRecent = lifecycleEvents[lifecycleEvents.length - 1];
    // Deliberately doesn't require startEntry to exist — if the original
    // "New session started" entry was ever lost (deleted, or otherwise
    // missing) but a "Session reopened" entry exists and is the most recent
    // lifecycle event, the booking is genuinely open. Requiring startEntry
    // here would make any booking that lost its first entry permanently
    // unable to be considered open again, no matter what gets clicked.
    const isOngoing = !!mostRecent && !/^session ended/i.test(mostRecent.note || '');

    let type = 'Unknown';
    let policyNumber = null;
    let ucNumber = null;
    let hbTaskNumber = null;
    if (startEntry) {
      const note = startEntry.note || '';
      const policyMatch = note.match(/\(Policy #(\d+)\)\s*$/);
      const ucMatch = note.match(/\(UC #(\d+)\)\s*$/);
      const hbMatch = note.match(/\(Task #(\d+)(?:,[^)]*)?\)\s*$/);
      policyNumber = policyMatch ? policyMatch[1] : null;
      ucNumber = ucMatch ? ucMatch[1] : null;
      hbTaskNumber = hbMatch ? hbMatch[1] : null;
      const noteClean = note.replace(/\s*\(Policy #\d+\)\s*$/, '').replace(/\s*\(UC #\d+\)\s*$/, '').replace(/\s*\(Task #\d+(?:,[^)]*)?\)\s*$/, '');
      const typeMatch = noteClean.match(/—\s*(.+)$/);
      type = typeMatch ? typeMatch[1].trim() : 'Unknown';
    }

    return { startEntry, mostRecentLifecycleEntry: mostRecent, isOngoing, type, policyNumber, ucNumber, hbTaskNumber };
  }

  // Reopens a booking that's already been ended, so new Task/Downtime/Lunch
  // entries can be logged under the SAME bookingId again instead of
  // starting a disconnected new one. Reuses the exact type/UC#/Policy#/
  // Task# the booking originally had — nothing needs to be re-entered.
  function reopenBooking(bookingId) {
    resetIdleTimer();
    if (myBookingId) {
      showStatus('⚠ Leave or end your current booking before reopening another one');
      return;
    }
    if (!canLogRightNow()) {
      showStatus(isViewingToday() ? '⚠ After 6:30 PM — view only, logging resumes tomorrow' : '⚠ Switch to today to reopen a booking');
      return;
    }
    const bookingEntries = entries.filter(e => e.bookingId === bookingId);
    if (bookingEntries.length === 0) {
      showStatus('⚠ Could not find that booking');
      return;
    }
    const info = getBookingLifecycleInfo(bookingEntries);
    if (info.isOngoing) {
      showStatus('⚠ That booking is already open — join it instead');
      renderActiveBookingsList();
      return;
    }
    // Same duplicate-identity safeguard startOrJoinBooking already applies —
    // a different, currently-open booking might have started under this
    // exact same type+number since this one closed. Reopening it anyway
    // would create two simultaneously-open bookings with the identical
    // identity, ambiguous which to Join.
    const reopenIdentity = bookingIdentifier(info.type, info.ucNumber, info.policyNumber, info.hbTaskNumber);
    const collision = computeActiveBookings().find(b =>
      b.bookingId !== bookingId && bookingIdentifier(b.type, b.ucNumber, b.policyNumber, b.hbTaskNumber) === reopenIdentity
    );
    if (collision) {
      showStatus(`⚠ ${info.type}${info.ucNumber ? ` (UC #${info.ucNumber})` : ''} is already open as a different booking — join that one instead, or relabel this one first`);
      renderActiveBookingsList();
      return;
    }
    const idSuffix = info.ucNumber ? ` (UC #${info.ucNumber})` : info.policyNumber ? ` (Policy #${info.policyNumber})` : info.hbTaskNumber ? ` (Task #${info.hbTaskNumber})` : '';
    logEntry('Session', `Session reopened — ${info.type}${idSuffix}`, null, null, bookingId);
    attachToBooking(
      bookingId,
      info.type,
      info.policyNumber ? parseInt(info.policyNumber, 10) : null,
      info.ucNumber ? parseInt(info.ucNumber, 10) : null,
      info.hbTaskNumber ? parseInt(info.hbTaskNumber, 10) : null
    );
    showStatus(`Reopened ${info.type}`);
  }

  // Lets a booking's type/UC#/Policy#/Task# be corrected after the fact —
  // works whether the booking is still active or already closed, since
  // everything downstream (Active Bookings, Session Log tabs, exports,
  // summaries) derives its label fresh from this one entry's note text
  // via getBookingLifecycleInfo, rather than from any separately-stored
  // value. Updating this one entry is enough for the change to appear
  // everywhere the booking's label is shown.
  function relabelBooking(bookingId) {
    const bookingEntries = entries.filter(e => e.bookingId === bookingId)
      .sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
    if (bookingEntries.length === 0) {
      showStatus('⚠ Could not find that booking');
      return;
    }
    const info = getBookingLifecycleInfo(bookingEntries);
    relabelFormOpenFor = bookingId;
    renderLog();
    // Pre-fill the form with the booking's current type/number once it's
    // actually in the DOM, rather than threading this through renderLog.
    setTimeout(() => {
      const typeSelect = document.getElementById('relabelTypeSelect');
      const numberInput = document.getElementById('relabelNumberInput');
      if (!typeSelect) return;
      const validTypes = ['Sim Data Collect', 'UC Data Collect', 'Targeted Data Collect', 'Policy Training', 'Lunch', 'Household Bridge Data Collection'];
      if (validTypes.includes(info.type)) {
        typeSelect.value = info.type;
      } else if (info.type !== 'Unknown') {
        typeSelect.value = 'Other';
        const otherInput = document.getElementById('relabelOtherInput');
        if (otherInput) { otherInput.style.display = 'block'; otherInput.value = info.type; }
      }
      if (numberInput) numberInput.value = info.ucNumber || info.policyNumber || info.hbTaskNumber || '';
      handleRelabelTypeChange();
    }, 0);
  }

  function handleRelabelTypeChange() {
    const typeSelect = document.getElementById('relabelTypeSelect');
    const otherInput = document.getElementById('relabelOtherInput');
    const numberRow = document.getElementById('relabelNumberRow');
    const numberLabel = document.getElementById('relabelNumberLabel');
    if (!typeSelect) return;
    const type = typeSelect.value;
    otherInput.style.display = (type === 'Other') ? 'block' : 'none';
    const needsNumber = (type === 'UC Data Collect' || type === 'Targeted Data Collect' || type === 'Household Bridge Data Collection' || type === 'Policy Training');
    numberRow.style.display = needsNumber ? 'flex' : 'none';
    if (numberLabel) {
      numberLabel.textContent = (type === 'Policy Training') ? 'Policy # (optional)' : (type === 'Household Bridge Data Collection') ? 'Task #' : 'UC #';
    }
  }

  function cancelRelabelForm() {
    relabelFormOpenFor = null;
    renderLog();
  }

  function submitRelabelForm(bookingId) {
    const typeSelect = document.getElementById('relabelTypeSelect');
    const otherInput = document.getElementById('relabelOtherInput');
    const numberInput = document.getElementById('relabelNumberInput');
    const newType = (typeSelect.value === 'Other') ? otherInput.value.trim() : typeSelect.value;
    if (!newType) { showStatus('⚠ Pick a type to relabel to'); return; }

    let newUcNumber = null, newPolicyNumber = null, newHbTaskNumber = null;
    const num = parseInt(numberInput.value, 10);
    if (newType === 'UC Data Collect' || newType === 'Targeted Data Collect') {
      if (!num || num < 1) { showStatus(`⚠ ${newType} needs a valid UC # — relabel cancelled`); return; }
      newUcNumber = num;
    } else if (newType === 'Policy Training') {
      if (num > 0) newPolicyNumber = num;
    } else if (newType === 'Household Bridge Data Collection') {
      if (!num || num < 1) { showStatus('⚠ Household Bridge needs a valid Task # — relabel cancelled'); return; }
      newHbTaskNumber = num;
    }

    // Same safeguard startOrJoinBooking already applies when starting a
    // booking — relabeling was bypassing it entirely, letting two
    // different, simultaneously-open bookings end up with the identical
    // identity (ambiguous which to Join, and the schedule can't tell them
    // apart either).
    const newIdentity = bookingIdentifier(newType, newUcNumber, newPolicyNumber, newHbTaskNumber);
    const collision = computeActiveBookings().find(b =>
      b.bookingId !== bookingId && bookingIdentifier(b.type, b.ucNumber, b.policyNumber, b.hbTaskNumber) === newIdentity
    );
    if (collision) {
      const idSuffix = newUcNumber ? ` (UC #${newUcNumber})` : newPolicyNumber ? ` (Policy #${newPolicyNumber})` : newHbTaskNumber ? ` (Task #${newHbTaskNumber})` : '';
      showStatus(`⚠ ${newType}${idSuffix} is already open as a different booking — relabel cancelled to avoid two bookings with the same identity`);
      return;
    }

    applyRelabel(bookingId, newType, newUcNumber, newPolicyNumber, newHbTaskNumber);
    relabelFormOpenFor = null;
  }

  // The actual update logic, shared regardless of how the new type/number
  // were collected — finds (or creates, if missing) the booking's start
  // entry and rewrites its note to the new, correctly-formatted identity.
  function applyRelabel(bookingId, newType, newUcNumber, newPolicyNumber, newHbTaskNumber) {
    const bookingEntries = entries.filter(e => e.bookingId === bookingId)
      .sort((a, b) => (entrySortValue(a) - entrySortValue(b)) || (a.seq - b.seq));
    let startEntry = bookingEntries.find(e => e.type === 'Session' && /new session started/i.test(e.note || ''));
    // The original start entry can end up missing — deleted, or never
    // correctly created in the first place — leaving a booking permanently
    // stuck as "Unknown" with nothing for Relabel to update. Rather than
    // fail here, create a new one using the earliest entry that DOES exist
    // for timing, so relabeling can still recover the booking.
    const isNewStartEntry = !startEntry;
    if (isNewStartEntry) {
      const earliest = bookingEntries[0];
      startEntry = {
        id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        seq: nextSeq++,
        date: earliest.date,
        timestamp: earliest.timestamp,
        type: 'Session',
        note: '',
        operator: earliest.operator || currentOperator || '',
        category: null,
        durationSeconds: null,
        bookingId: bookingId
      };
    }

    const idSuffix = newUcNumber ? ` (UC #${newUcNumber})` : newPolicyNumber ? ` (Policy #${newPolicyNumber})` : newHbTaskNumber ? ` (Task #${newHbTaskNumber})` : '';
    const newNote = `New session started — ${newType}${idSuffix}`;
    startEntry.note = newNote;

    if (isNewStartEntry) {
      entries.push(startEntry);
    }

    if (supabaseClient && !String(startEntry.id).startsWith('local_')) {
      supabaseClient.from('entries').update({ note: newNote }).eq('id', startEntry.id)
        .then(({ error }) => {
          if (error) {
            console.warn('Relabel sync failed:', error);
            setSyncStatus('offline — relabel not yet synced', 'status-error');
          }
        });
    } else if (isNewStartEntry && supabaseClient) {
      supabaseClient.from('entries').insert(entryToRow(startEntry)).select().single()
        .then(({ data, error }) => {
          if (error) {
            console.warn('New start entry sync failed:', error);
            setSyncStatus('offline — relabel not yet synced', 'status-error');
          } else if (data) {
            startEntry.id = data.id;
          }
        });
    }

    // If THIS device is currently attached to the booking being relabeled,
    // update the local state too so the UI reflects it immediately rather
    // than waiting for the next re-render to re-derive it from scratch.
    if (myBookingId === bookingId) {
      mainSessionType = newType;
      currentUcNumber = newUcNumber;
      currentPolicyNumber = newPolicyNumber;
      currentHbTaskNumber = newHbTaskNumber;
      updateSessionButton();
    }

    renderLog();
    renderActiveBookingsList();
    updateTotals();
    showStatus(`Relabeled to ${newType}${idSuffix}`);
  }

  function bookingIdentifier(type, ucNum, policyNum, hbTaskNum) {
    // The thing that makes a booking "the same" for join-vs-start purposes:
    // for UC Data Collect and Targeted Data Collect it's the UC number;
    // for Policy Training it's the Policy number; for Household Bridge
    // it's the task number; anything else is identified by type alone.
    if (type === 'UC Data Collect' || type === 'Targeted Data Collect') return `${type}|${ucNum || ''}`;
    if (type === 'Policy Training') return `Policy Training|${policyNum || ''}`;
    if (type === 'Household Bridge Data Collection') return `Household Bridge Data Collection|${hbTaskNum || ''}`;
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
      const info = getBookingLifecycleInfo(evs);
      if (!info.isOngoing) return;

      const operators = [...new Set(evs.map(e => e.operator).filter(Boolean))];
      // Falls back to the segment's own earliest entry when there's no real
      // start entry to read from — same situation getBookingLifecycleInfo
      // already handles for isOngoing, just needed here too now that a
      // booking without one can still correctly reach this point.
      const earliestEntry = info.startEntry || evs[0];

      active.push({
        bookingId,
        type: info.type,
        policyNumber: info.policyNumber,
        ucNumber: info.ucNumber,
        hbTaskNumber: info.hbTaskNumber,
        operators: operators.join(', ') || '—',
        startDate: earliestEntry.date,
        startTime: earliestEntry.timestamp
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
      let idText = '';
      let progressText = '';
      if (b.ucNumber) idText = ` (UC #${b.ucNumber})`;
      else if (b.policyNumber) idText = ` (Policy #${b.policyNumber})`;
      else if (b.hbTaskNumber) {
        idText = ` (Task #${b.hbTaskNumber})`;
        const progress = computeHbTaskProgress(parseInt(b.hbTaskNumber, 10));
        if (progress.targetHours > 0) {
          progressText = ` — ${formatDuration(progress.accumulatedSeconds)} of ${progress.targetHours}h`;
        }
      }
      const isMine = b.bookingId === myBookingId;
      return `
        <div class="active-booking-row">
          <div>
            <div class="active-booking-label">${escapeHtml(b.type)}${idText}${progressText}${isMine ? ' <span style="color:var(--accent);">— you</span>' : ''}</div>
            <div class="active-booking-meta">Started ${formatDateShort(b.startDate)} ${b.startTime} — ${escapeHtml(b.operators)}</div>
          </div>
          ${isMine ? '' : `<button class="join-booking-btn" onclick="joinBooking('${b.bookingId}')">Join</button>`}
        </div>
      `;
    }).join('');
  }

  let currentHbTaskNumber = null;

  function renderScheduleList() {
    const items = getTodaysScheduleItems().map(parseScheduleItem).filter(Boolean);
    ['scheduleOverlayList', 'scheduleCardList'].forEach(containerId => {
      const container = document.getElementById(containerId);
      if (!container) return;
      if (items.length === 0) {
        container.innerHTML = '<div class="schedule-empty">Nothing on today\u2019s schedule yet.</div>';
        return;
      }
      container.innerHTML = items.map(item => {
        const progress = computeScheduleItemProgress(item);
        const pct = progress.targetHours > 0 ? Math.min(100, Math.round((progress.accumulatedHours / progress.targetHours) * 100)) : 0;
        const label = item.number ? `${item.type} (${item.numberKind} #${item.number})` : item.type;
        const met = progress.accumulatedHours >= progress.targetHours;
        return `
          <div class="schedule-item">
            <div class="schedule-item-top">
              <span class="schedule-item-label">${escapeHtml(label)}</span>
              <button class="schedule-remove-btn" onclick="removeScheduleItem('${item.id}')">✕</button>
            </div>
            <div class="schedule-progress-bar"><div class="schedule-progress-fill ${met ? 'met' : ''}" style="width:${pct}%;"></div></div>
            <div class="schedule-item-numbers">${formatDuration(progress.accumulatedSeconds)} of ${item.targetHours}h ${met ? '\u2713 met' : `(${pct}%)`}</div>
          </div>
        `;
      }).join('');
    });
  }

  let currentPolicyNumber = null;
  let currentUcNumber = null;

  function attachToBooking(bookingId, type, policyNumber, ucNumber, hbTaskNumber) {
    myBookingId = bookingId;
    mainSessionType = type;
    currentPolicyNumber = policyNumber;
    currentUcNumber = ucNumber;
    currentHbTaskNumber = hbTaskNumber || null;
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
    currentHbTaskNumber = null;
    sessionEnded = true;
    try { sessionStorage.removeItem(MY_BOOKING_KEY); } catch (err) { /* ignore */ }

    const typeSelect = document.getElementById('mainSessionTypeSelect');
    const otherInput = document.getElementById('mainSessionOtherInput');
    const policyInput = document.getElementById('policyNumberInput');
    const ucInput = document.getElementById('ucNumberInput');
    const hbTaskInput = document.getElementById('hbTaskNumberInput');
    const hbTargetInput = document.getElementById('hbTargetHoursInput');
    if (typeSelect) { typeSelect.value = ''; typeSelect.disabled = false; }
    if (otherInput) { otherInput.value = ''; otherInput.style.display = 'none'; otherInput.disabled = false; }
    if (policyInput) { policyInput.value = ''; policyInput.disabled = false; }
    if (ucInput) { ucInput.value = ''; ucInput.disabled = false; }
    if (hbTaskInput) { hbTaskInput.value = ''; hbTaskInput.disabled = false; }
    if (hbTargetInput) { hbTargetInput.value = ''; hbTargetInput.disabled = false; document.getElementById('hbTargetHoursRow').style.display = 'none'; }

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
    logEntry('Session', `Joined booking — ${booking.type}${booking.ucNumber ? ` (UC #${booking.ucNumber})` : booking.policyNumber ? ` (Policy #${booking.policyNumber})` : booking.hbTaskNumber ? ` (Task #${booking.hbTaskNumber})` : ''}`, null, null, bookingId);
    attachToBooking(bookingId, booking.type, booking.policyNumber, booking.ucNumber, booking.hbTaskNumber);
    showStatus(`Joined ${booking.type}`);
  }

  function startOrJoinBooking() {
    resetIdleTimer();
    if (!canLogRightNow()) {
      showStatus(isViewingToday() ? '⚠ After 6:30 PM — view only, logging resumes tomorrow' : '⚠ Switch to today to start a booking');
      return;
    }
    if (myBookingId) {
      showStatus('⚠ You are already attached to a booking');
      return;
    }
    const typeSelect = document.getElementById('mainSessionTypeSelect');
    const otherInput = document.getElementById('mainSessionOtherInput');
    const policyInput = document.getElementById('policyNumberInput');
    const ucInput = document.getElementById('ucNumberInput');
    const hbTaskInput = document.getElementById('hbTaskNumberInput');
    const hbTargetInput = document.getElementById('hbTargetHoursInput');

    const chosenType = (typeSelect.value === 'Other') ? otherInput.value.trim() : typeSelect.value;
    if (!chosenType) {
      showStatus('⚠ Pick a booking type before starting');
      typeSelect.focus();
      return;
    }

    const ucVal = parseInt(ucInput.value, 10);
    const ucNumber = (ucVal > 0) ? ucVal : null;
    if ((chosenType === 'UC Data Collect' || chosenType === 'Targeted Data Collect') && !ucNumber) {
      showStatus(`⚠ Enter a UC # before starting a ${chosenType} booking`);
      ucInput.focus();
      return;
    }
    const policyVal = parseInt(policyInput.value, 10);
    const policyNumber = (policyVal > 0) ? policyVal : null;

    const hbTaskVal = parseInt(hbTaskInput.value, 10);
    const hbTaskNumber = (hbTaskVal > 0) ? hbTaskVal : null;
    let hbTargetHours = null;
    if (chosenType === 'Household Bridge Data Collection') {
      if (!hbTaskNumber) {
        showStatus('⚠ Enter a Task # before starting a Household Bridge booking');
        hbTaskInput.focus();
        return;
      }
      const existingTarget = findHbTaskTarget(hbTaskNumber);
      if (existingTarget === null) {
        const targetVal = parseFloat(hbTargetInput.value);
        if (!targetVal || targetVal <= 0) {
          showStatus('⚠ This is the first time for this task — enter a target in hours to set the goal');
          hbTargetInput.focus();
          return;
        }
        hbTargetHours = targetVal;
      } else {
        hbTargetHours = existingTarget;
      }
    }

    // If a booking with this same identity is already running, offer to
    // join it instead of starting a duplicate, confusing, overlapping one.
    const identity = bookingIdentifier(chosenType, ucNumber, policyNumber, hbTaskNumber);
    const existing = computeActiveBookings().find(b =>
      bookingIdentifier(b.type, b.ucNumber, b.policyNumber, b.hbTaskNumber) === identity
    );
    if (existing) {
      showStatus(`⚠ That's already running — click "Join" on it in the Active Bookings list above instead`);
      return;
    }

    const bookingId = generateBookingId();
    let idSuffix = '';
    if (ucNumber) idSuffix = ` (UC #${ucNumber})`;
    else if (policyNumber) idSuffix = ` (Policy #${policyNumber})`;
    else if (hbTaskNumber) {
      // Embed the target the first time this task number is ever started,
      // so computeHbTaskProgress can find it later purely from history —
      // same pattern as UC#/Policy#, no separate storage needed.
      const isFirstTimeForTask = (findHbTaskTarget(hbTaskNumber) === null);
      idSuffix = isFirstTimeForTask ? ` (Task #${hbTaskNumber}, Target: ${hbTargetHours}h)` : ` (Task #${hbTaskNumber})`;
    }
    logEntry('Session', `New session started — ${chosenType}${idSuffix}`, null, null, bookingId);
    currentTaskNumber = 1; // a genuinely new booking starts fresh, not continuing the last one's count
    taskInProgress = false;
    taskStartTimestamp = null;
    updateTaskButton();
    attachToBooking(bookingId, chosenType, policyNumber, ucNumber, hbTaskNumber);
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
    if (lunchInProgress) {
      showStatus('⚠ End Lunch before ending the booking');
      return;
    }
    const idSuffix = currentUcNumber ? ` (UC #${currentUcNumber})` : currentPolicyNumber ? ` (Policy #${currentPolicyNumber})` : currentHbTaskNumber ? ` (Task #${currentHbTaskNumber})` : '';
    logEntry('Session', `Session ended — ${mainSessionType}${idSuffix}`, null, null, myBookingId);
    showStatus('Booking ended');
    detachFromMyBooking();
  }

  // Distinct from ending: this detaches YOU from the booking so you're free
  // to join or start something else, but the booking record itself stays
  // open — for whoever else is on it, or for you to rejoin later via the
  // same Join button already used for active bookings. Same safety checks
  // as ending, since leaving with something still mid-log would orphan it
  // exactly the same way ending would.
  function leaveBooking() {
    resetIdleTimer();
    if (!myBookingId) return;
    // Unlike ending a booking, leaving is meant to be a quick, low-friction
    // way to step away — auto-close whatever's running rather than forcing
    // it to be stopped manually first. Nothing gets lost: each gets logged
    // as a normal completed/ended entry, just tagged as auto-closed.
    if (taskInProgress) {
      const durationSeconds = taskStartTimestamp ? Math.round((new Date() - taskStartTimestamp) / 1000) : 0;
      logEntry('Active', `Task ${currentTaskNumber} completed (${formatDuration(durationSeconds)}) — auto-closed: left booking`, durationSeconds);
      taskInProgress = false;
      taskStartTimestamp = null;
      updateTaskButton();
    }
    if (downtimeInProgress) {
      autoCloseDowntime('left booking');
    }
    if (lunchInProgress) {
      autoCloseLunch('left booking');
    }
    const idSuffix = currentUcNumber ? ` (UC #${currentUcNumber})` : currentPolicyNumber ? ` (Policy #${currentPolicyNumber})` : currentHbTaskNumber ? ` (Task #${currentHbTaskNumber})` : '';
    logEntry('Session', `Left booking — ${mainSessionType}${idSuffix}`, null, null, myBookingId);
    showStatus('Left the booking — it stays open for anyone else on it, or for you to rejoin later');
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
    const relabelRow = document.getElementById('relabelActiveRow');
    if (status) {
      if (sessionEnded) {
        status.textContent = "You're not attached to a booking yet.";
        status.classList.remove('active');
        if (relabelRow) relabelRow.style.display = 'none';
      } else {
        const idText = currentUcNumber ? ` (UC #${currentUcNumber})` : currentPolicyNumber ? ` (Policy #${currentPolicyNumber})` : currentHbTaskNumber ? ` (Task #${currentHbTaskNumber})` : '';
        let progressText = '';
        if (currentHbTaskNumber) {
          const progress = computeHbTaskProgress(currentHbTaskNumber);
          progressText = ` — ${formatDuration(progress.accumulatedSeconds)} of ${progress.targetHours}h collected`;
        }
        status.textContent = `You're on: ${mainSessionType}${idText}${progressText}`;
        status.classList.add('active');
        if (relabelRow) relabelRow.style.display = 'block';
      }
    }
    updateWorkControlsGating();
  }

  function relabelMyCurrentBooking() {
    if (!myBookingId) return;
    relabelBooking(myBookingId);
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

  async function confirmOperatorPrompt() {
    const select = document.getElementById('operatorPromptSelect');
    const otherInput = document.getElementById('operatorPromptOtherInput');
    const chosen = (select.value === 'Other') ? otherInput.value.trim() : select.value;
    if (!chosen) {
      otherInput.focus();
      return;
    }
    currentOperator = chosen;
    document.getElementById('operatorPromptOverlay').style.display = 'none';
    document.getElementById('scheduleOverlay').style.display = 'flex';
    // initApp() loads entries from Supabase and does all normal init —
    // running it now (while mainWrap is still hidden behind this overlay)
    // means it's already complete by the time "Continue" is pressed, and
    // renderScheduleList() below shows real, up-to-date data instead of
    // an empty list from before entries were ever loaded.
    await initApp();
    renderScheduleList();
  }

  function confirmScheduleOverlay() {
    document.getElementById('scheduleOverlay').style.display = 'none';
    document.getElementById('mainWrap').style.display = 'block';
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
    enforceOperatingHoursCutoff();

    updateTaskButton();
    updateDowntimeButton();
    updateSessionButton();
    updateDateNavUI();
    updateTotals();
    renderLog();
    syncOperatorSelect();
    restoreViewMode();
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