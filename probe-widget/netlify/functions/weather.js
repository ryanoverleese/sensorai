// netlify/functions/weather.js
// Simple and reliable Open-Meteo function
exports.handler = async (event) => {
  try {
    const params = new URLSearchParams(event.queryStringParameters || {});
    const q = (params.get("q") || "").trim();
    const zip = (params.get("zip") || "").trim();

    // 1️⃣ Determine search query
    const search = zip || q || "Holdrege, NE";
    console.log("[weather] incoming query:", search);

    // 2️⃣ Detect ZIP codes and convert to city/state via zippopotam API
    let locationQuery = search;
    if (/^\d{5}$/.test(search)) {
      const zRes = await fetch(`https://api.zippopotam.us/us/${search}`);
      if (zRes.ok) {
        const zJson = await zRes.json();
        const place = zJson.places?.[0];
        if (place) {
          locationQuery = `${place["place name"]}, ${place["state abbreviation"]}, US`;
          console.log("[weather] zip resolved to:", locationQuery);
        }
      } else {
        console.warn("[weather] ZIP lookup failed, fallback to geocoding");
      }
    }

    // 3️⃣ Geocode location using Open-Meteo
    const query = encodeURIComponent(
      locationQuery.replace(/,?\s*NE\b/i, "").replace(/,?\s*US\b/i, "") + ", US"
    );
    const geoURL = `https://geocoding-api.open-meteo.com/v1/search?name=${query}&count=1&language=en&format=json`;

    const geoRes = await fetch(geoURL);
    const geo = await geoRes.json();

    if (!geo.results || geo.results.length === 0) {
      console.error("[weather] no geocode results:", geo);
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Location not found", query: locationQuery })
      };
    }

    const { latitude, longitude, name, country_code } = geo.results[0];
    console.log("[weather] resolved ->", { latitude, longitude, name, country_code });

    // 4️⃣ Fetch current weather data
    const wxURL = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,precipitation,wind_speed_10m&timezone=America/Chicago`;
    const wxRes = await fetch(wxURL);
    const wx = await wxRes.json();

    if (!wx.current) {
      console.error("[weather] no current data:", wx);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Weather data unavailable" })
      };
    }

    // 5️⃣ Return simplified data
    const F = (c) => (c != null ? (c * 9) / 5 + 32 : null);
    const MPH = (ms) => (ms != null ? ms * 2.23694 : null);

    const output = {
      location: `${name}, ${country_code}`,
      coords: { lat: latitude, lon: longitude },
      temperature_F: F(wx.current.temperature_2m),
      precipitation_mm: wx.current.precipitation ?? null,
      wind_mph: MPH(wx.current.wind_speed_10m)
    };

    console.log("[weather] success:", output);
    return {
      statusCode: 200,
      body: JSON.stringify(output)
    };
  } catch (err) {
    console.error("[weather] error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Weather fetch failed",
        details: err.message
      })
    };
  }
};