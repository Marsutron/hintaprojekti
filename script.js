// Remote price API + fallbacks (mirrors `app.py`)
const API_URL = "https://api.porssisahko.net/v1/latest-prices.json";
const PROXY_PREFIXES = [
    "https://api.allorigins.win/raw?url=",
    "https://cors.bridged.cc/",
    "https://api.codetabs.com/v1/proxy?quest="
];
const PRICE_URLS = [API_URL, ...PROXY_PREFIXES.map(p => p + API_URL)];
const TIMEZONE = 'Europe/Helsinki';
const HOUR_RANGE_START = 6;
const HOUR_RANGE_END = 22;
const UPDATE_INTERVAL = 60 * 1000; // Päivitä näkymä minuutin välein
const CACHE_REFRESH_HOUR = 14;
const CACHE_REFRESH_MINUTE = 30;

const STORAGE_KEY = 'hintaprojekti_prices_cache_v1';

// State
let cachedData = null; // { prices, fetchedAt, source, rawPrices }
let lastFetchTime = null; // ms since epoch

// DOM elements
const pricesContainer = document.getElementById('pricesContainer');
const avgPriceEl = document.getElementById('avgPrice');
const minPriceEl = document.getElementById('minPrice');
const maxPriceEl = document.getElementById('maxPrice');
const lastUpdateEl = document.getElementById('lastUpdate');
const viewGridBtn = document.getElementById('viewGridBtn');
const viewListBtn = document.getElementById('viewListBtn');
const mainTitleEl = document.getElementById('mainTitle');

let selectedViewIndex = 1; // 0 = grid view (both days), 1 = list view (bars)

function getDateKey(date) {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function getTomorrow(date) {
    const tomorrow = new Date(date);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate());
}

function isSameDay(a, b) {
    return a.getTime() === b.getTime();
}

function getTodayRefreshCutoff(now = new Date()) {
    return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        CACHE_REFRESH_HOUR,
        CACHE_REFRESH_MINUTE,
        0,
        0
    );
}

function normalizePrices(rawPrices) {
    if (!Array.isArray(rawPrices)) return [];
    const prices = rawPrices.map(p => {
        const startDate = new Date(p.startDate);
        return {
            time: startDate,
            price: p.price,
            hour: startDate.getHours(),
            date: new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())
        };
    });
    prices.sort((a, b) => a.time - b.time);
    return prices;
}

function loadCacheFromStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.rawPrices) || !parsed.fetchedAt) return null;
        const fetchedAtMs = Date.parse(parsed.fetchedAt);
        if (!Number.isFinite(fetchedAtMs)) return null;

        return {
            rawPrices: parsed.rawPrices,
            prices: normalizePrices(parsed.rawPrices),
            fetchedAt: parsed.fetchedAt,
            source: parsed.source || null,
            fetchedAtMs,
        };
    } catch {
        return null;
    }
}

function saveCacheToStorage(data) {
    try {
        const payload = {
            rawPrices: data.rawPrices,
            fetchedAt: data.fetchedAt,
            source: data.source || null,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
        // ignore storage errors (quota/private mode)
    }
}

// Event listeners
document.addEventListener('DOMContentLoaded', initializeApp);

function initializeApp() {
    updateViewButtons();
    addViewNavigationListeners();
    addSwipeListeners();
    addKeyboardNavigation();
    loadAndDisplay();

    // Päivitä näkymä minuutin välein ja lataa uudet arvot, kun vuorokausi vaihtuu
    setInterval(() => {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (cachedData && cachedData.prices && lastFetchTime) {
            const lastFetchDay = new Date(new Date(lastFetchTime).getFullYear(), new Date(lastFetchTime).getMonth(), new Date(lastFetchTime).getDate());
            if (!isSameDay(today, lastFetchDay)) {
                cachedData = null;
                lastFetchTime = null;
                loadAndDisplay();
                return;
            }
            displayPrices(cachedData.prices);
            updateLastUpdate();
        }
    }, UPDATE_INTERVAL);
}

async function loadAndDisplay() {
    try {
        const data = await getPricesWithCache();
        cachedData = data;
        displayPrices(data.prices);
        updateStats(data.prices);
        updateLastUpdate();
        
    } catch (error) {
        console.error('Virhe hintojen lataamisessa:', error);
        pricesContainer.innerHTML = `<div class="error">Virhe hintojen lataamisessa. Yritetään uudelleen myöhemmin...</div>`;
    }
}

async function getPricesWithCache() {
    const now = new Date();
    const nowMs = now.getTime();

    if (!cachedData) {
        const stored = loadCacheFromStorage();
        if (stored) {
            cachedData = {
                prices: stored.prices,
                rawPrices: stored.rawPrices,
                fetchedAt: stored.fetchedAt,
                source: stored.source,
            };
            lastFetchTime = stored.fetchedAtMs;
        }
    }

    // 1) If no cache -> fetch newest
    if (!cachedData || !cachedData.rawPrices || !cachedData.prices || cachedData.prices.length === 0) {
        const fresh = await fetchPrices();
        cachedData = fresh;
        lastFetchTime = Date.parse(fresh.fetchedAt);
        saveCacheToStorage(fresh);
        return fresh;
    }

    // 2) Cache exists: refresh only after 14:30 local time
    const cutoff = getTodayRefreshCutoff(now).getTime();
    if (nowMs < cutoff) {
        return cachedData;
    }

    // After 14:30: refresh if cache is from before today's cutoff
    if (lastFetchTime && lastFetchTime >= cutoff) {
        return cachedData;
    }

    try {
        const fresh = await fetchPrices();
        cachedData = fresh;
        lastFetchTime = Date.parse(fresh.fetchedAt);
        saveCacheToStorage(fresh);
        return fresh;
    } catch (err) {
        // If refresh fails, fall back to cached data
        console.warn('Uusien hintojen lataus epäonnistui, käytetään välimuistia:', err);
        return cachedData;
    }
}

async function fetchPrices() {
    let lastError = null;
    let data = null;
    let source = null;

    for (const url of PRICE_URLS) {
        try {
            const response = await fetch(url, {
                cache: 'no-store',
                headers: { 'Accept': 'application/json' }
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const json = await response.json();
            if (!json || !Array.isArray(json.prices) || json.prices.length === 0) {
                throw new Error('Väärä vastausrakenne tai ei hintoja');
            }

            data = json;
            source = url;
            break;
        } catch (err) {
            lastError = err;
        }
    }

    if (!data) {
        throw new Error(`Kaikki hinnanhoitoyritykset epäonnistuivat: ${lastError?.message || lastError}`);
    }

    const rawPrices = data.prices;
    const prices = normalizePrices(rawPrices);
    // `latest-prices.json` doesn't include `fetched_at`, so set it locally.
    return { prices, rawPrices, fetchedAt: new Date().toISOString(), source };
}

function displayGridView(filteredPrices, currentHour, today, tomorrow) {
    const dateGroups = filteredPrices.reduce((acc, p) => {
        const dateKey = p.date.getTime();
        const dateStr = p.date.toLocaleDateString('fi-FI', { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
        if (!acc[dateKey]) {
            acc[dateKey] = { date: p.date, dateStr, prices: [] };
        }
        acc[dateKey].prices.push(p);
        return acc;
    }, {});

    let html = '';

    // Käsittele kunkin päivän hinnat
    Object.entries(dateGroups).forEach(([dateKey, group]) => {
        if (group.prices.length === 0) return;

        // Etsi 3 halvinta ja 3 kalleinta hinnan perusteella
        const cheapTimes = getTopPrices(group.prices, 3, true);   // halvimmat
        const expensiveTimes = getTopPrices(group.prices, 3, false); // kalleimmat

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
    });

    pricesContainer.innerHTML = html;
}

function displayListView(filteredPrices, currentHour, today) {
    const dateGroups = filteredPrices.reduce((acc, p) => {
        const dateKey = p.date.getTime();
        const dateStr = p.date.toLocaleDateString('fi-FI', { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
        if (!acc[dateKey]) {
            acc[dateKey] = { date: p.date, dateStr, prices: [] };
        }
        acc[dateKey].prices.push(p);
        return acc;
    }, {});

    const sortedGroups = Object.entries(dateGroups)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([, group]) => group);

    let html = '';
    for (const group of sortedGroups) {
        if (!group.prices.length) continue;

        // Päiväkohtainen vertailu: halvimmat/kalleimmat vain tämän päivän tunneista
        const cheapTimes = getTopPrices(group.prices, 3, true);
        const expensiveTimes = getTopPrices(group.prices, 3, false);

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

    pricesContainer.innerHTML = html;
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
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = getTomorrow(today);
    const validDates = new Set([today.getTime(), tomorrow.getTime()]);

    const filteredPrices = prices.filter(p => validDates.has(p.date.getTime()) && p.hour >= HOUR_RANGE_START && p.hour <= HOUR_RANGE_END);
    if (filteredPrices.length === 0) {
        pricesContainer.innerHTML = '<div class="error">Ei hintoja nykyiselle tai seuraavalle päivälle.</div>';
        return;
    }

    if (selectedViewIndex === 0) {
        // Grid view - both days
        displayGridView(filteredPrices, currentHour, today, tomorrow);
    } else {
        // List view - horizontal bars
        displayListView(filteredPrices, currentHour, today);
    }
}

function getTopPrices(prices, count, ascending = true) {
    return [...prices]
        .sort((a, b) => ascending ? a.price - b.price : b.price - a.price)
        .slice(0, count)
        .map(p => p.time.getTime());
}

function createPriceBox(p, currentHour, today, expensiveTimes, cheapTimes) {
    const priceValue = p.price.toFixed(2);
    const hourStr = String(p.hour).padStart(2, '0');
    const isToday = p.date.getTime() === today.getTime();
    const isCurrent = isToday && p.hour === currentHour;
    const isExpensive = expensiveTimes.includes(p.time.getTime());
    const isCheap = cheapTimes.includes(p.time.getTime());
    
    let className = 'price-box';
    if (isExpensive) {
        className += ' expensive';
    } else if (isCheap) {
        className += ' cheap';
    } else {
        className += ' moderate';
    }
    if (isCurrent) {
        className += ' current';
    }
    
    return `
        <div class="${className}" title="${formatDateTime(p.time)}">
            <div class="price-hour">${hourStr}:00</div>
            <div class="price-value">${priceValue}</div>
            <div class="price-unit">c/kWh</div>
        </div>
    `;
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
    if (normalizedIndex === selectedViewIndex) {
        return;
    }
    selectedViewIndex = normalizedIndex;
    updateViewButtons();
    if (cachedData && cachedData.prices) {
        displayPrices(cachedData.prices);
    }
}

function updateViewButtons() {
    viewGridBtn.classList.toggle('active', selectedViewIndex === 0);
    viewListBtn.classList.toggle('active', selectedViewIndex === 1);
}

function addViewNavigationListeners() {
    viewGridBtn.addEventListener('click', () => setSelectedView(0));
    viewListBtn.addEventListener('click', () => setSelectedView(1));
}

function addSwipeListeners() {
    let startX = null;
    let isSwipeStarted = false;
    const threshold = 50;

    // Kuuntele pointerdown dokumentissa ja tarkista että se alkoi pricesContainerista
    document.addEventListener('pointerdown', event => {
        if (pricesContainer.contains(event.target)) {
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
            setSelectedView(selectedViewIndex + 1);
        } else {
            // Pyyhkäisy oikealle -> edellinen näkymä
            setSelectedView(selectedViewIndex - 1);
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
            setSelectedView(selectedViewIndex - 1);
        } else if (event.key === 'ArrowRight') {
            setSelectedView(selectedViewIndex + 1);
        }
    });
}

function updateStats(prices) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // Laske stats vain tänään olevista hinnoista
    const todayPrices = prices
        .filter(p => p.hour >= HOUR_RANGE_START && p.hour <= HOUR_RANGE_END)
        .filter(p => p.date.getTime() === today.getTime());
    
    if (todayPrices.length > 0) {
        const pricesValues = todayPrices.map(p => p.price);
        const avgPrice = pricesValues.reduce((a, b) => a + b, 0) / pricesValues.length;
        const minPrice = Math.min(...pricesValues);
        const maxPrice = Math.max(...pricesValues);
        
        avgPriceEl.textContent = avgPrice.toFixed(3);
        minPriceEl.textContent = minPrice.toFixed(3);
        maxPriceEl.textContent = maxPrice.toFixed(3);
    }
}

function updateLastUpdate() {
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
    const fullStr = `${dateStr} klo ${timeStr}`;
    
    // Käytä latausajan arvoa jos saatavilla
    let updateTimeStr = timeStr;
    if (cachedData && cachedData.fetchedAt) {
        try {
            const fetchedDate = new Date(cachedData.fetchedAt);
            updateTimeStr = fetchedDate.toLocaleTimeString('fi-FI', {
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (e) {
            // Jos parsinta epäonnistuu, käytä nykyistä aikaa
        }
    }
    
    mainTitleEl.textContent = `Sähkön tuntihinnat - ${dateStr} klo ${updateTimeStr}`;
    const sourceText = cachedData?.source ? ` (lähde: ${cachedData.source})` : '';
    lastUpdateEl.textContent = `Päivitetty: ${updateTimeStr}${sourceText}`;
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
