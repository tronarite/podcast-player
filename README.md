# podcast-player

Reproductor web de podcasts y audioseries para autoalojar. Sin dependencias: solo Node.js.
Incluye una app Android (WebView) para usarlo desde el móvil.

- **Biblioteca desde carpetas:** cada carpeta es una serie y cada audio un episodio. Lee etiquetas ID3, portadas y capítulos; se completa con `data/library.json`.
- **Progreso, cola y favoritos** guardados por usuario.
- **Login opcional** (`AUTH=on`) con contraseñas hasheadas con scrypt y sesión firmada.
- **Streaming con Range** (adelantar y retroceder sin descargar todo).

Formatos: `.mp3 .m4a .ogg .opus .wav .flac .aac`.

## Arrancar

Requiere Node.js 18 o superior.

```sh
PODCAST_DIR=/ruta/a/tus/podcasts node server.js
# http://127.0.0.1:48213
```

En PowerShell: `$env:PODCAST_DIR='D:\Podcasts'; node server.js`.

### Variables de entorno

| Variable | Por defecto | Qué hace |
|---|---|---|
| `PODCAST_DIR` | — | Carpeta de la biblioteca. **Defínela siempre.** |
| `PORT` | `48213` | Puerto. |
| `HOST` | `127.0.0.1` | `0.0.0.0` para abrirlo a la red local. |
| `AUTH` | `off` | `on` exige usuario y contraseña. |
| `ALLOWED_HOSTS` | vacío (cualquiera) | Lista `host:puerto` aceptada; el resto recibe 421 (contra DNS rebinding). |
| `TRUST_PROXY` | — | Actívala solo si va detrás de un proxy inverso. |

### Usuarios (con `AUTH=on`)

```sh
node manage-users.js add <usuario>      # pide la contraseña (o usa PODCAST_PASSWORD)
```

Los datos (usuarios, clave de sesión, progreso, portadas) se guardan en `data/`, que no se versiona.

## Docker

```sh
cp .env.example .env       # ajusta BIND_IP, PORT y PODCAST_DIR
docker compose up -d --build
```

El contenedor corre como usuario sin privilegios, con sistema de ficheros de solo lectura, sin capacidades de Linux y con la biblioteca montada en solo lectura.
`AUTH` está en `off` en `docker-compose.yml`: no expongas el puerto a internet sin activarlo o sin una VPN como Tailscale.

> El `Dockerfile` y el `docker-compose.yml` no se han probado en la última revisión del repo; el servidor sí (ver abajo).

## App Android

Descarga `MiBiblioteca.apk` desde [Releases](../../releases). Al abrirla por primera vez pide la dirección del servidor (por ejemplo `http://192.168.1.10:48213/`) y la recuerda; si no conecta, vuelve a preguntarla.
El tráfico va en HTTP sin cifrar, pensado para red local o túnel (Tailscale/VPN).

Para compilarla tú mismo hace falta el SDK de Android (build-tools 34, plataforma android-34) y un JDK 17:

```sh
ANDROID_HOME=/ruta/al/sdk JAVA_HOME=/ruta/al/jdk17 sh android/build.sh
```

La primera vez genera `android/release.jks` (tu clave de firma, no se versiona). **Guárdala:** las actualizaciones del APK deben ir firmadas con la misma.

## Estructura

```
server.js        servidor HTTP y API
lib/             auth, escaneo de la biblioteca, lector ID3
public/          interfaz web
manage-users.js  gestión de usuarios
android/         app Android (WebView), compila sin Gradle
```

## Pruebas realizadas

Servidor ejecutado desde una copia limpia del repo con una biblioteca de prueba: listado de series y episodios, streaming (`206` con Range), guardado y lectura del progreso, bloqueo de rutas fuera de la biblioteca (404), rechazo de `Host` no permitido (421), y el flujo de login (sin sesión 401, contraseña mala 401, correcta 200, acceso con cookie 200).
