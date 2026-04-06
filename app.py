import json
import random
from datetime import datetime, timedelta
from pathlib import Path

import requests
from flask import Flask, jsonify
from flask_cors import CORS

API_URL = "https://api.porssisahko.net/v1/latest-prices.json"
PROXY_PREFIXES = [
    "https://api.allorigins.win/raw?url=",
    "https://cors.bridged.cc/",
    "https://api.codetabs.com/v1/proxy?quest="
]
CACHE_TTL = 6 * 60 * 60
RETRY_MIN = 45 * 60
RETRY_MAX = 90 * 60
CACHE_FILE = Path(__file__).parent / "prices_cache.json"

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

cache = {
    'prices': None,
    'fetched_at': None,
    'next_retry': None,
    'error': None,
    'source': None,
}


def now_timestamp():
    return datetime.utcnow().timestamp()


def load_cache_from_disk():
    """Lataa välimuisti levyltä JSON-tiedostosta"""
    if CACHE_FILE.exists():
        try:
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                cache.update(data)
                # Muunna fetched_at ja next_retry takaisin timestamp-muodoksi
                if cache.get('fetched_at'):
                    cache['fetched_at'] = float(cache['fetched_at'])
                if cache.get('next_retry'):
                    cache['next_retry'] = float(cache['next_retry'])
                return True
        except Exception as e:
            print(f"Välimuistin lataamisessa virhe: {e}")
    return False


def save_cache_to_disk():
    """Tallentaa välimuistin JSON-tiedostoon"""
    try:
        # Muutetaan timestamp:it stringiksi JSON-yhteensopivuuden vuoksi
        cache_to_save = {
            'prices': cache['prices'],
            'fetched_at': cache['fetched_at'],
            'next_retry': cache['next_retry'],
            'error': cache['error'],
            'source': cache['source'],
        }
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache_to_save, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Välimuistin tallentamisessa virhe: {e}")


def fetch_remote_prices():
    urls = [API_URL] + [prefix + API_URL for prefix in PROXY_PREFIXES]
    last_error = None

    for url in urls:
        try:
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            data = response.json()

            if not isinstance(data, dict) or 'prices' not in data or not data['prices']:
                raise ValueError('Väärä vastausrakenne tai ei hintoja')

            return data['prices'], url
        except Exception as exc:
            last_error = exc
            continue

    raise RuntimeError(f'Kaikki hinnanhoitoyritykset epäonnistuivat: {last_error}')


def refresh_cache():
    prices, source = fetch_remote_prices()
    # Sortaa hinnat aika-järjestyksessä
    sorted_prices = sorted(prices, key=lambda p: p.get('startDate', ''))
    cache['prices'] = sorted_prices
    cache['fetched_at'] = now_timestamp()
    cache['next_retry'] = None
    cache['error'] = None
    cache['source'] = source
    save_cache_to_disk()
    return cache


def get_cached_prices():
    now = now_timestamp()
    if cache['prices'] and cache['fetched_at'] and (now - cache['fetched_at']) < CACHE_TTL:
        return cache, None

    if cache['next_retry'] and now < cache['next_retry']:
        warning = None
        if cache['prices']:
            warning = 'Palvelin käyttää vanhaa välimuistia ja yrittää myöhemmin uudelleen.'
            return cache, warning
        raise RuntimeError('Palvelin ei pysty hankkimaan hintatietoja juuri nyt.')

    try:
        return refresh_cache(), None
    except Exception as exc:
        delay = RETRY_MIN + random.random() * (RETRY_MAX - RETRY_MIN)
        cache['next_retry'] = now + delay
        cache['error'] = str(exc)
        save_cache_to_disk()
        if cache['prices']:
            warning = f'Hintojen lataus epäonnistui: {exc}. Käytetään vanhaa tietoa.'
            return cache, warning
        raise



@app.route('/')
def index():
    return app.send_static_file('index.html')


@app.route('/api/prices')
def api_prices():
    try:
        result, warning = get_cached_prices()
        response = {
            'prices': result['prices'],
            'fetched_at': datetime.utcfromtimestamp(result['fetched_at']).isoformat() + 'Z' if result['fetched_at'] else None,
            'source': result['source'],
            'warning': warning,
        }
        return jsonify(response)
    except Exception as exc:
        if cache['prices']:
            response = {
                'prices': cache['prices'],
                'fetched_at': datetime.utcfromtimestamp(cache['fetched_at']).isoformat() + 'Z' if cache['fetched_at'] else None,
                'source': cache['source'],
                'warning': f'Palvelin ei saanut uutta tietoa: {exc}. Käytetään vanhaa välimuistia.',
            }
            return jsonify(response), 200
        return jsonify({'error': str(exc)}), 503


if __name__ == '__main__':
    load_cache_from_disk()
    app.run(host='0.0.0.0', port=5000, debug=True)
