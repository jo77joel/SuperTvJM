# Qué debe hacer la app Super TV (para que el panel muestre "Instalada ✓")

La app, al abrirse, pide el **código de activación** (el que se ve en la página del cliente, 8 letras/números)
y llama a tu servidor. El servidor responde y el panel muestra "Instalada ✓" con el modelo del aparato.

## Llamada
POST  https://TU-DOMINIO/api/app/activar      (Content-Type: application/json)
Cuerpo:  {"codigo":"AB12CD34","id":"<id único del aparato>","modelo":"<modelo>"}

Respuestas:
- 200 {"ok":true,"nombre":"...","expira":<ms>}  -> activada, dejar entrar
- 402 pago pendiente | 404 código incorrecto | 410 vencido | 403 límite de dispositivos
  -> mostrar mensaje y NO dejar entrar

Llámala en el primer arranque y también cada vez que se abra la app (así, si vence o se bloquea, la app se cierra).
Guarda el código en la app (SharedPreferences) para no pedirlo cada vez.

## Ejemplo (Java, Android) – ejecutar en un hilo aparte, no en el principal
String id = android.provider.Settings.Secure.getString(getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
String json = "{\"codigo\":\"" + codigo + "\",\"id\":\"" + id + "\",\"modelo\":\"" + android.os.Build.MODEL.replace("\"", "") + "\"}";
java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL("https://TU-DOMINIO/api/app/activar").openConnection();
c.setRequestMethod("POST"); c.setRequestProperty("Content-Type", "application/json"); c.setDoOutput(true);
c.setConnectTimeout(10000); c.setReadTimeout(10000);
c.getOutputStream().write(json.getBytes("UTF-8"));
int code = c.getResponseCode();   // 200 = OK
// Necesita en el AndroidManifest:  <uses-permission android:name="android.permission.INTERNET"/>

## Dispositivos
Por defecto cada cliente puede activar 2 aparatos (variable MAX_DISPOSITIVOS en Render, opcional).
Si cambia de TV: en el panel, botón "Reiniciar dispositivos".
