// Backend API
// # const API_URL = '/api/prices';
const API_URL = "https://api.porssisahko.net/v1/latest-prices.json";
const TIMEZONE = 'Europe/Helsinki';
const HOUR_RANGE_START = 6;
const HOUR_RANGE_END = 22;
const UPDATE_INTERVAL = 60 * 1000; // Päivitä näkymä minuutin välein
const API_CACHE_TIME = 12 * 60 * 60 * 1000; // 12-14 tunnin väli
const RETRY_MIN = 45 * 60 * 1000; // 45 minuuttia
const RETRY_MAX = 90 * 60 * 1000; // 90 minuuttia

// State
let cachedData = null; // { prices, fetchedAt }
let lastFetchTime = null;
let failureRetryTime = null;

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
    const now = Date.now();
    const today = new Date();
    const currentDayKey = getDateKey(today);

    if (cachedData && lastFetchTime) {
        const lastFetchDayKey = getDateKey(new Date(lastFetchTime));
        if (currentDayKey !== lastFetchDayKey) {
            cachedData = null;
            lastFetchTime = null;
        }
    }

    // Jos viimeinen lataus oli alle 12-14 tuntia sitten, käytä cachea
    if (cachedData && lastFetchTime && (now - lastFetchTime) < API_CACHE_TIME) {
        return cachedData;
    }
    
    // Jos epäonnistumisen jälkeen ei ole kulunut 45-90 minuuttia, yritä uudelleen
    if (failureRetryTime && (now - failureRetryTime) < RETRY_MIN) {
        const waitTime = RETRY_MIN - (now - failureRetryTime);
        throw new Error(`Odotellaan uudelleenyritystä (${Math.ceil(waitTime / 1000 / 60)} min)`);
    }
    
    try {
        const data = await fetchPrices();
        lastFetchTime = now;
        failureRetryTime = null;
        return data;
    } catch (error) {
        // Aseta uudelleenyritysaika (45-90 min)
        const retryDelay = RETRY_MIN + Math.random() * (RETRY_MAX - RETRY_MIN);
        failureRetryTime = now;
        
        // Yritä uudelleen automaattisesti myöhemmin
        setTimeout(() => {
            lastFetchTime = 0;
            loadAndDisplay();
        }, retryDelay);
        
        throw error;
    }
}

async function fetchPrices() {
    const response = await fetch(API_URL, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`API virhe: ${response.status}`);
    }

    const data = await response.json();
    if (!data.prices || data.prices.length === 0) {
        throw new Error('Ei hintoja vastauksessa');
    }

    const prices = data.prices.map(p => {
        const startDate = new Date(p.startDate);
        return {
            time: startDate,
            price: p.price,
            hour: startDate.getHours(),
            date: new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())
        };
    });

    prices.sort((a, b) => a.time - b.time);
    return { prices, fetchedAt: data.fetched_at };
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
    // Yhdistä kaikki tunnit ja järjestä päivämäärän ja tunnin mukaan kronologisesti
    const allPrices = [...filteredPrices].sort((a, b) => {
        if (a.date.getTime() !== b.date.getTime()) {
            return a.date - b.date;
        }
        return a.hour - b.hour;
    });

    // Etsi 3 halvinta ja 3 kalleinta koko datasta
    const cheapTimes = getTopPrices(allPrices, 3, true);
    const expensiveTimes = getTopPrices(allPrices, 3, false);

    const minPrice = Math.min(...allPrices.map(p => p.price));
    const maxPrice = Math.max(...allPrices.map(p => p.price));
    const priceRange = Math.max(1, maxPrice - minPrice);

    const pricedPrices = allPrices.map(p => ({
        ...p,
        category: expensiveTimes.includes(p.time.getTime()) ? 'expensive' :
                  cheapTimes.includes(p.time.getTime()) ? 'cheap' :
                  'moderate',
        widthPercent: 25 + ((p.price - minPrice) / priceRange) * 70
    }));

    let html = '<div class="list-view">';
    html += pricedPrices.map(p => createHourBar(p, currentHour, today)).join('');
    html += '</div>';

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
    
    // Käytä backendin päivitysaikaa jos saatavilla
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
    lastUpdateEl.textContent = `Backend päivittynyt: ${updateTimeStr}`;
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
