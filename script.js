// =========================
// Config
// =========================
const CONFIG = {
    apiUrl: "api/proxy.php",
    hourRange: { start: 6, end: 22 },
    updateIntervalMs: 60 * 1000,
    storageKey: 'hintaprojekti_prices_cache_v1'
};

// =========================
// State + DOM
// =========================
const state = {
    selectedViewIndex: 1, // 0 = grid, 1 = list
    data: null, // { prices, rawPrices, fetchedAt, source }
    lastFetchMs: null,
    noticeHtml: null
};

const dom = {};

function initDom() {
    dom.pricesContainer = document.getElementById('pricesContainer');
    dom.avgPrice = document.getElementById('avgPrice');
    dom.minPrice = document.getElementById('minPrice');
    dom.maxPrice = document.getElementById('maxPrice');
    dom.lastUpdate = document.getElementById('lastUpdate');
    dom.mainTitle = document.getElementById('mainTitle');
    dom.viewGridBtn = document.getElementById('viewGridBtn');
    dom.viewListBtn = document.getElementById('viewListBtn');

    // Välttämättömät elementit, jotta sovellus voi piirtää mitään.
    const essentialKeys = ['pricesContainer', 'avgPrice', 'minPrice', 'maxPrice', 'lastUpdate', 'mainTitle'];
    const missing = essentialKeys.filter(k => !dom[k]);
    if (missing.length > 0) {
        console.error(`hintaprojekti: puuttuvat elementit: ${missing.join(', ')}`);
        return false;
    }

    return true;
}

// =========================
// Date helpers
// =========================
function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSameDay(a, b) {
    return startOfDay(a).getTime() === startOfDay(b).getTime();
}

function getTomorrow(date) {
    const d = new Date(date);
    d.setDate(d.getDate() + 1);
    return startOfDay(d);
}

// =========================
// Data transform
// =========================
function normalizePrices(rawPrices) {
    if (!Array.isArray(rawPrices)) return [];
    const prices = rawPrices.map(p => {
        const start = new Date(p.startDate);
        return {
            time: start,
            price: p.price,
            hour: start.getHours(),
            date: startOfDay(start)
        };
    });
    prices.sort((a, b) => a.time - b.time);
    return prices;
}

function groupByDay(prices) {
    const groups = new Map();
    for (const p of prices) {
        const key = p.date.getTime();
        if (!groups.has(key)) {
            const dateStr = p.date.toLocaleDateString('fi-FI', { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
            groups.set(key, { date: p.date, dateStr, prices: [] });
        }
        groups.get(key).prices.push(p);
    }
    return [...groups.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, group]) => group);
}

function getTopTimes(prices, count, ascending) {
    return [...prices]
        .sort((a, b) => ascending ? a.price - b.price : b.price - a.price)
        .slice(0, count)
        .map(p => p.time.getTime());
}

// =========================
// Storage cache
// =========================
function loadCacheFromStorage() {
    try {
        const raw = localStorage.getItem(CONFIG.storageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.rawPrices) || !parsed.fetchedAt) return null;
        const fetchedAtMs = Date.parse(parsed.fetchedAt);
        if (!Number.isFinite(fetchedAtMs)) return null;

        return {
            rawPrices: parsed.rawPrices,
            fetchedAt: parsed.fetchedAt,
            source: parsed.source || null,
            fetchedAtMs,
            prices: normalizePrices(parsed.rawPrices)
        };
    } catch {
        return null;
    }
}

function saveCacheToStorage(data) {
    try {
        localStorage.setItem(CONFIG.storageKey, JSON.stringify({
            rawPrices: data.rawPrices,
            fetchedAt: data.fetchedAt,
            source: data.source || null
        }));
    } catch {
        // ignore storage errors (quota/private mode)
    }
}

// =========================
// API
// =========================
function getReadableFetchError(err) {
    const message = err?.message || String(err);
    if (/Failed to fetch/i.test(message)) {
        return 'Selaimesta tehty pyyntö API:lle estyy (tyypillisesti CORS) tai verkkoyhteys ei toimi.';
    }
    if (/HTTP\s+\d+/i.test(message)) {
        return 'API palautti virheen, eikä hintoja saatu ladattua.';
    }
    return 'Hinnat eivät latautuneet odotetusti.';
}

function formatFiTimeOrDash(isoString) {
    if (!isoString) return '-';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });
}

function buildNoticeHtml(type, text) {
    const cls = type === 'warning' ? 'warning' : 'error';
    return `<div class="notice ${cls}" role="alert">${text}</div>`;
}

async function getPricesWithCache() {
    state.noticeHtml = null;

    // Check if we have data in memory
    if (state.data?.prices?.length && state.data?.rawPrices?.length) {
        return state.data;
    }

    // Check localStorage cache
    const stored = loadCacheFromStorage();

    // Check if cache is still valid (has prices for today or tomorrow)
    if (stored?.prices?.length && stored?.rawPrices?.length) {
        const now = new Date();
        const today = startOfDay(now);
        const tomorrow = getTomorrow(today);
        const validDates = new Set([today.getTime(), tomorrow.getTime()]);

        const hasValidPrices = stored.prices.some(p => validDates.has(p.date.getTime()));

        if (hasValidPrices) {
            state.data = { prices: stored.prices, rawPrices: stored.rawPrices, fetchedAt: stored.fetchedAt, source: stored.source };
            state.lastFetchMs = stored.fetchedAtMs;
            return state.data;
        } else {
            localStorage.removeItem(CONFIG.storageKey);
        }
    }

    // No valid cache, fetch from API
    try {
        const response = await fetch(CONFIG.apiUrl, {
            cache: 'no-store',
            headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const json = await response.json();
        if (!json || !Array.isArray(json.prices) || json.prices.length === 0) {
            throw new Error('Väärä vastausrakenne tai ei hintoja');
        }

        const rawPrices = json.prices;
        const fresh = {
            rawPrices,
            prices: normalizePrices(rawPrices),
            fetchedAt: new Date().toISOString(),
            source: CONFIG.apiUrl
        };

        state.data = fresh;
        state.lastFetchMs = Date.parse(fresh.fetchedAt);
        saveCacheToStorage(fresh);
        return fresh;
    } catch (err) {
        console.error('Hintojen haku epäonnistui:', err);
        const details = getReadableFetchError(err);
        throw new Error(`Hintoja ei saatu ladattua. ${details}`);
    }
}

// =========================
// Scheduled refreshes
// =========================
function getNextRefreshTime() {
    const now = new Date();
    const refreshTimes = [
        { hour: 2, minute: 30 },
        { hour: 14, minute: 30 }
    ];

    for (const time of refreshTimes) {
        const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.hour, time.minute, 0, 0);
        if (next > now) return next;
    }

    // If we've passed both times today, schedule for 02:30 tomorrow
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 2, 30, 0, 0);
}

function scheduleRefreshes() {
    function scheduleNext() {
        const nextRefresh = getNextRefreshTime();
        const now = new Date();
        const msUntilRefresh = nextRefresh.getTime() - now.getTime();

        setTimeout(() => {
            state.data = null;
            state.lastFetchMs = null;
            loadAndRender();
            scheduleNext();
        }, msUntilRefresh);
    }

    scheduleNext();
}

// =========================
// App lifecycle
// =========================
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

function initializeApp() {
    // Estä moninkertainen alustus (esim. jos sama skripti on liitetty sivulle useaan kertaan).
    const initKey = '__hintaprojekti_prices_app_v1__';
    if (window[initKey]) return;

    // Kotisivuympäristöissä DOM voi olla vielä rakentumassa (SPA/teemat).
    // Yritetään rajatusti uudelleen, jos pakolliset elementit eivät ole vielä paikalla.
    const retryKey = '__hintaprojekti_prices_app_retries_v1__';
    const currentRetries = window[retryKey] || 0;
    if (!initDom()) {
        const maxRetries = 20;
        if (currentRetries < maxRetries) {
            window[retryKey] = currentRetries + 1;
            setTimeout(() => initializeApp(), 150);
        } else {
            console.error('hintaprojekti: sovellus ei löytänyt tarvittavia DOM-elementtejä.');
        }
        return;
    }

    window[retryKey] = 0;
    window[initKey] = true;

    updateViewButtons();
    addViewNavigationListeners();
    addSwipeListeners();
    addKeyboardNavigation();
    loadAndRender();

    // Schedule refreshes at 02:30 and 14:30
    scheduleRefreshes();

    // Update UI every minute
    setInterval(() => {
        if (!state.data?.prices?.length) return;
        renderPrices(state.data.prices);
        renderLastUpdate();
    }, CONFIG.updateIntervalMs);
}

async function loadAndRender() {
    try {
        state.noticeHtml = null;
        const data = await getPricesWithCache();
        state.data = data;
        state.lastFetchMs = Date.parse(data.fetchedAt);

        renderPrices(data.prices);
        renderStats(data.prices);
        renderLastUpdate();

        if (state.noticeHtml) {
            dom.pricesContainer.insertAdjacentHTML('afterbegin', state.noticeHtml);
            state.noticeHtml = null;
        }
    } catch (error) {
        console.error('loadAndRender error:', error);
        state.noticeHtml = null;
        dom.pricesContainer.innerHTML = buildNoticeHtml(
            'error',
            error?.message ? error.message : 'Virhe hintojen lataamisessa. Yritetään uudelleen myöhemmin...'
        );
    }
}

function displayGridView(filteredPrices, currentHour, today, tomorrow) {
    let html = '';
    for (const group of groupByDay(filteredPrices)) {
        if (!group.prices.length) continue;

        // Etsi 3 halvinta ja 3 kalleinta hinnan perusteella
        const cheapTimes = getTopTimes(group.prices, 3, true);
        const expensiveTimes = getTopTimes(group.prices, 3, false);

        // Lisää kategoria-tag jokaisen hinnan objektiin
        group.prices = group.prices.map(p => ({
            ...p,
            category: expensiveTimes.includes(p.time.getTime()) ? 'expensive' :
                      cheapTimes.includes(p.time.getTime()) ? 'cheap' :
                      'moderate'
        }));

        // Sortaa kronologisesti
        group.prices.sort((a, b) => a.hour - b.hour);

        // Näytä kronologisessa järjestyksessä värikoodatuina
        html += `<div class="day-section"><h2>${group.dateStr}</h2><div class="day-prices">`;
        html += group.prices.map(p => createPriceBoxWithCategory(p, currentHour, today)).join('');
        html += '</div></div>';
    }

    dom.pricesContainer.innerHTML = html;
}

function displayListView(filteredPrices, currentHour, today) {
    let html = '';
    for (const group of groupByDay(filteredPrices)) {
        if (!group.prices.length) continue;

        // Päiväkohtainen vertailu: halvimmat/kalleimmat vain tämän päivän tunneista
        const cheapTimes = getTopTimes(group.prices, 3, true);
        const expensiveTimes = getTopTimes(group.prices, 3, false);

        const minPrice = Math.min(...group.prices.map(p => p.price));
        const maxPrice = Math.max(...group.prices.map(p => p.price));
        const priceRange = Math.max(1e-9, maxPrice - minPrice);

        const pricedPrices = [...group.prices]
            .sort((a, b) => a.hour - b.hour)
            .map(p => ({
                ...p,
                category: expensiveTimes.includes(p.time.getTime()) ? 'expensive' :
                          cheapTimes.includes(p.time.getTime()) ? 'cheap' :
                          'moderate',
                widthPercent: 25 + ((p.price - minPrice) / priceRange) * 70
            }));

        html += `<div class="day-section"><h2>${group.dateStr}</h2><div class="list-view">`;
        html += pricedPrices.map(p => createHourBar(p, currentHour, today)).join('');
        html += '</div></div>';
    }

    dom.pricesContainer.innerHTML = html;
}

function createHourBar(p, currentHour, today) {
    const priceValue = p.price.toFixed(2);
    const hourStr = String(p.hour).padStart(2, '0') + ':00';
    const isToday = p.date.getTime() === today.getTime();
    const isCurrent = isToday && p.hour === currentHour;

    let className = 'hour-bar';
    className += ' ' + p.category;

    if (isCurrent) {
        className += ' current';
    }

    const dateStr = p.date.toLocaleDateString('fi-FI', { weekday: 'short', month: '2-digit', day: '2-digit' });
    const widthPercent = Math.max(30, Math.min(95, p.widthPercent || 50));

    return `
        <div class="${className}" style="width: ${widthPercent}%" title="${formatDateTime(p.time)}">
            <span class="hour-time">${hourStr}</span>
            <span class="hour-date">${dateStr}</span>
            <span class="hour-price">${priceValue} c/kWh</span>
        </div>
    `;
}

function displayPrices(prices) {
    const now = new Date();
    const currentHour = now.getHours();
    const today = startOfDay(now);
    const tomorrow = getTomorrow(today);
    const validDates = new Set([today.getTime(), tomorrow.getTime()]);

    const filteredPrices = prices.filter(p =>
        validDates.has(p.date.getTime()) &&
        p.hour >= CONFIG.hourRange.start &&
        p.hour <= CONFIG.hourRange.end
    );
    if (filteredPrices.length === 0) {
        dom.pricesContainer.innerHTML = '<div class="error">Ei hintatietoja nykyiselle tai seuraavalle päivälle.</div>';
        return;
    }

    if (state.selectedViewIndex === 0) {
        displayGridView(filteredPrices, currentHour, today, tomorrow);
    } else {
        displayListView(filteredPrices, currentHour, today);
    }
}

function createPriceBoxWithCategory(p, currentHour, today) {
    const priceValue = p.price.toFixed(2);
    const hourStr = String(p.hour).padStart(2, '0');
    const isToday = p.date.getTime() === today.getTime();
    const isCurrent = isToday && p.hour === currentHour;
    
    let className = 'price-box';
    className += ' ' + p.category;
    
    if (isCurrent) {
        className += ' current';
    }
    
    return `
        <div class="${className}" title="${formatDateTime(p.time)}">
            ${isCurrent ? '<div class="current-indicator">Nykyinen</div>' : ''}
            <div class="price-hour">${hourStr}:00</div>
            <div class="price-value">${priceValue}</div>
            <div class="price-unit">c/kWh</div>
        </div>
    `;
}

function setSelectedView(index) {
    const normalizedIndex = Math.max(0, Math.min(index, 1));
    if (normalizedIndex === state.selectedViewIndex) {
        return;
    }
    state.selectedViewIndex = normalizedIndex;
    updateViewButtons();
    if (state.data?.prices) {
        renderPrices(state.data.prices);
    }
}

function updateViewButtons() {
    if (dom.viewGridBtn) {
        dom.viewGridBtn.classList.toggle('active', state.selectedViewIndex === 0);
    }
    if (dom.viewListBtn) {
        dom.viewListBtn.classList.toggle('active', state.selectedViewIndex === 1);
    }
}

function addViewNavigationListeners() {
    if (dom.viewGridBtn) {
        dom.viewGridBtn.addEventListener('click', () => setSelectedView(0));
    }
    if (dom.viewListBtn) {
        dom.viewListBtn.addEventListener('click', () => setSelectedView(1));
    }
}

function addSwipeListeners() {
    let startX = null;
    let isSwipeStarted = false;
    const threshold = 50;

    // Kuuntele pointerdown dokumentissa ja tarkista että se alkoi pricesContainerista
    document.addEventListener('pointerdown', event => {
        if (dom.pricesContainer.contains(event.target)) {
            startX = event.clientX;
            isSwipeStarted = true;
        }
    });

    // Kuuntele pointerup dokumentissa
    document.addEventListener('pointerup', event => {
        if (!isSwipeStarted || startX === null) {
            return;
        }
        const deltaX = event.clientX - startX;
        startX = null;
        isSwipeStarted = false;

        if (Math.abs(deltaX) < threshold) {
            return;
        }
        if (deltaX < 0) {
            // Pyyhkäisy vasemmalle -> seuraava näkymä
            setSelectedView(state.selectedViewIndex + 1);
        } else {
            // Pyyhkäisy oikealle -> edellinen näkymä
            setSelectedView(state.selectedViewIndex - 1);
        }
    });

    // Reset jos osoitin peruutetaan
    document.addEventListener('pointercancel', () => {
        startX = null;
        isSwipeStarted = false;
    });
}

function addKeyboardNavigation() {
    document.addEventListener('keydown', event => {
        if (event.key === 'ArrowLeft') {
            setSelectedView(state.selectedViewIndex - 1);
        } else if (event.key === 'ArrowRight') {
            setSelectedView(state.selectedViewIndex + 1);
        }
    });
}

// =========================
// Rendering helpers
// =========================
function renderPrices(prices) {
    displayPrices(prices);
}

function renderStats(prices) {
    const now = new Date();
    const today = startOfDay(now);

    const todayPrices = prices
        .filter(p => p.hour >= CONFIG.hourRange.start && p.hour <= CONFIG.hourRange.end)
        .filter(p => p.date.getTime() === today.getTime());

    if (todayPrices.length > 0) {
        const pricesValues = todayPrices.map(p => p.price);
        const avgPrice = pricesValues.reduce((a, b) => a + b, 0) / pricesValues.length;
        const minPrice = Math.min(...pricesValues);
        const maxPrice = Math.max(...pricesValues);

        dom.avgPrice.textContent = avgPrice.toFixed(3);
        dom.minPrice.textContent = minPrice.toFixed(3);
        dom.maxPrice.textContent = maxPrice.toFixed(3);
    }
}

function renderLastUpdate() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('fi-FI', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
    const timeStr = now.toLocaleTimeString('fi-FI', {
        hour: '2-digit',
        minute: '2-digit'
    });

    let updateTimeStr = timeStr;
    if (state.data?.fetchedAt) {
        try {
            const fetchedDate = new Date(state.data.fetchedAt);
            updateTimeStr = fetchedDate.toLocaleTimeString('fi-FI', {
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (e) {
            // ignore parse errors
        }
    }

    dom.mainTitle.textContent = `Sähkön tuntihinnat - ${dateStr} klo ${updateTimeStr}`;
    const sourceText = state.data?.source ? ` (lähde: ${state.data.source})` : '';
    dom.lastUpdate.textContent = `Päivitetty: ${updateTimeStr}${sourceText}`;
}

function formatDateTime(date) {
    return date.toLocaleString('fi-FI', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}
