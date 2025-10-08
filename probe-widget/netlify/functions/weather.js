// netlify/functions/weather.js
exports.handler = async (event) => {
  try {
    const params = new URLSearchParams(event.queryStringParameters || {});
    const q = (params.get("q") || "").trim();
    const zip = (params.get("zip") || "").trim();
    const search = zip || q || "68959"; // default ZIP Holdrege

    console.log("[weather] incoming query:", search);

    let latitude, longitude, locationLabel;

    // 1️⃣ Try ZIP lookup first if it's a ZIP or known small town
    if (/^\d{5}$/.test(search)) {
      const zRes = await fetch(`https://api.zippopotam.us/us/${search}`);
      if (zRes.ok) {
        const zJson = await zRes.json();
        const place = zJson.places?.[0];
        latitude = parseFloat(place.latitude);
        longitude = parseFloat(place.longitude);
        locationLabel = `${place["place name"]}, ${place["state abbreviation"]}`;
      }
    }

    // 2️⃣ If no ZIP match yet, try geocoding the name
    if (!latitude || !longitude) {
      const query = encodeURIComponent(
        search.replace(/,?\s*NE\b/i, "") + ", US"
      );
      const geoRes = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${query}&count=1&language=en&format=json`
      );
      const geo = await geoRes.json();
      if (geo.results && geo.results.length > 0) {
        const { latitude: lat, longitude: lon, name, country_code } = geo.results[0];
        latitude = lat;
        longitude = lon;
        locationLabel = `${name}, ${country_code}`;
      }
    }

    // 3️⃣ If still not found, hardcode known fallback for Holdrege area
    if (!latitude || !longitude) {
      console.warn("[weather] fallback to Holdrege, NE coordinates");
      latitude = 40.4405;
      longitude = -99.3698;
      locationLabel = "Holdrege, NE";
    }

    // 4️⃣ Fetch weather data
    const wxURL = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,precipitation,wind_speed_10m&timezone=America/Chicago`;
    const wxRes = await fetch(wxURL);
    const wx = await wxRes.json();

    if (!wx.current) {
      throw new Error("Weather data unavailable");
    }

    // 5️⃣ Format output
    const F = (c) => (c != null ? (c * 9) / 5 + 32 : null);
    const MPH = (ms) => (ms != null ? ms * 2.23694 : null);

    return {
      statusCode: 200,
      body: JSON.stringify({
        location: locationLabel,
        coords: { lat: latitude, lon: longitude },
        temperature_F: F(wx.current.temperature_2m),
        precipitation_mm: wx.current.precipitation ?? null,
        wind_mph: MPH(wx.current.wind_speed_10m)
      })
    };
  } catch (err) {
    console.error("[weather] error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Weather fetch failed", details: err.message })
    };
  }
};