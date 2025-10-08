// netlify/functions/weather.js
exports.handler = async (event) => {
  try {
    const params = new URLSearchParams(event.queryStringParameters || {});
    const q = params.get("q") || "Holdrege, NE";

    // Convert simple city name → coordinates (optional)
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1`
    );
    const geo = await geoRes.json();

    if (!geo.results || geo.results.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Location not found" })
      };
    }

    const { latitude, longitude, name, country_code } = geo.results[0];

    // Fetch current + today’s weather
    const wxRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,precipitation,wind_speed_10m&timezone=America/Chicago`
    );
    const wx = await wxRes.json();

    return {
      statusCode: 200,
      body: JSON.stringify({
        location: `${name}, ${country_code}`,
        temperature_F: wx.current ? (wx.current.temperature_2m * 9) / 5 + 32 : null,
        precipitation_mm: wx.current?.precipitation ?? null,
        wind_mph: wx.current?.wind_speed_10m
          ? wx.current.wind_speed_10m * 2.23694
          : null
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