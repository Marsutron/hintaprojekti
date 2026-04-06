// =========================
// Config
// =========================
const CONFIG = {
    apiUrl: "https://api.porssisahko.net/v1/latest-prices.json",
    proxyPrefixes: [
        "https://api.allorigins.win/raw?url=",
        "https://cors.bridged.cc/",
        "https://api.codetabs.com/v1/proxy?quest="
    ],
    hourRange: { start: 6, end: 22 },
    refreshCutoff: { hour: 14, minute: 30 }, // local time
    updateIntervalMs: 60 * 1000,
    storageKey: 'hintaprojekti_prices_cache_v1'
};

const PRICE_URLS = [CONFIG.apiUrl, ...CONFIG.proxyPrefixes.map(p => p + CONFIG.apiUrl)];

// =========================
// State + DOM
// =========================
const state = {
    selectedViewIndex: 1, // 0 = grid, 1 = list
    data: null, // { prices, rawPrices, fetchedAt, source }
    lastFetchMs: null
};

const dom = {
    pricesContainer: document.getElementById('pricesContainer'),
    avgPrice: document.getElementById('avgPrice'),
    minPrice: document.getElementById('minPrice'),
    maxPrice: document.getElementById('maxPrice'),
    lastUpdate: document.getElementById('lastUpdate'),
    viewGridBtn: document.getElementById('viewGridBtn'),
    viewListBtn: document.getElementById('viewListBtn'),
    mainTitle: document.getElementById('mainTitle')
};

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

function getTodayRefreshCutoff(now = new Date()) {
    return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        CONFIG.refreshCutoff.hour,
        CONFIG.refreshCutoff.minute,
        0,
        0
    );
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
async function fetchPrices() {
    let lastError = null;
    for (const url of PRICE_URLS) {
        try {
            const response = await fetch(url, {
                cache: 'no-store',
                headers: { 'Accept': 'application/json' }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const json = await response.json();
            if (!json || !Array.isArray(json.prices) || json.prices.length === 0) {
                throw new Error('Väärä vastausrakenne tai ei hintoja');
            }

            const rawPrices = json.prices;
            return {
                rawPrices,
                prices: normalizePrices(rawPrices),
                fetchedAt: new Date().toISOString(), // API doesn't provide fetched_at
                source: url
            };
        } catch (err) {
            lastError = err;
        }
    }
    throw new Error(`Kaikki hinnanhoitoyritykset epäonnistuivat: ${lastError?.message || lastError}`);
}

async function getPricesWithCache() {
    const now = new Date();
    const cutoffMs = getTodayRefreshCutoff(now).getTime();

    if (!state.data) {
        const stored = loadCacheFromStorage();
        if (stored) {
            state.data = { prices: stored.prices, rawPrices: stored.rawPrices, fetchedAt: stored.fetchedAt, source: stored.source };
            state.lastFetchMs = stored.fetchedAtMs;
        }
    }

    // No cache -> always fetch
    if (!state.data?.prices?.length || !state.data?.rawPrices?.length) {
        const fresh = await fetchPrices();
        state.data = fresh;
        state.lastFetchMs = Date.parse(fresh.fetchedAt);
        saveCacheToStorage(fresh);
        return fresh;
    }

    // Cache exists -> only refresh after cutoff
    const nowMs = now.getTime();
    if (nowMs < cutoffMs) return state.data;
    if (state.lastFetchMs && state.lastFetchMs >= cutoffMs) return state.data;

    try {
        const fresh = await fetchPrices();
        state.data = fresh;
        state.lastFetchMs = Date.parse(fresh.fetchedAt);
        saveCacheToStorage(fresh);
        return fresh;
    } catch (err) {
        console.warn('Uusien hintojen lataus epäonnistui, käytetään välimuistia:', err);
        return state.data;
    }
}

// =========================
// App lifecycle
// =========================
document.addEventListener('DOMContentLoaded', initializeApp);

function initializeApp() {
    updateViewButtons();
    addViewNavigationListeners();
    addSwipeListeners();
    addKeyboardNavigation();
    loadAndRender();

    setInterval(() => {
        if (!state.data?.prices?.length || !state.lastFetchMs) return;
        const now = new Date();
        const lastFetchDate = new Date(state.lastFetchMs);
        if (!isSameDay(now, lastFetchDate)) {
            state.data = null;
            state.lastFetchMs = null;
            loadAndRender();
            return;
        }
        renderPrices(state.data.prices);
        renderLastUpdate();
    }, CONFIG.updateIntervalMs);
}

async function loadAndRender() {
    try {
        const data = await getPricesWithCache();
        state.data = data;
        state.lastFetchMs = Date.parse(data.fetchedAt);

        renderPrices(data.prices);
        renderStats(data.prices);
        renderLastUpdate();
    } catch (error) {
        console.error('Virhe hintojen lataamisessa:', error);
        dom.pricesContainer.innerHTML = `<div class="error">Virhe hintojen lataamisessa. Yritetään uudelleen myöhemmin...</div>`;
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
        dom.pricesContainer.innerHTML = '<div class="error">Ei hintoja nykyiselle tai seuraavalle päivälle.</div>';
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
    dom.viewGridBtn.classList.toggle('active', state.selectedViewIndex === 0);
    dom.viewListBtn.classList.toggle('active', state.selectedViewIndex === 1);
}

function addViewNavigationListeners() {
    dom.viewGridBtn.addEventListener('click', () => setSelectedView(0));
    dom.viewListBtn.addEventListener('click', () => setSelectedView(1));
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
    
    // Laske stats vain tänään olevista hinnoista
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
    
    // Käytä latausajan arvoa jos saatavilla
    let updateTimeStr = timeStr;
    if (state.data?.fetchedAt) {
        try {
            const fetchedDate = new Date(state.data.fetchedAt);
            updateTimeStr = fetchedDate.toLocaleTimeString('fi-FI', {
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (e) {
            // Jos parsinta epäonnistuu, käytä nykyistä aikaa
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
