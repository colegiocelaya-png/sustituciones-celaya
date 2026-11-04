# Sustituciones CEIP Gabriel Celaya — puesta en marcha

Resultado: una web con tu propio enlace (https://algo.vercel.app), que el profesorado instala en el móvil como una app y que **envía notificaciones** (Android: normal; iPhone: tras añadirla a la pantalla de inicio). Nadie necesita cuenta de Claude. Todo es gratuito en los planes básicos.

Necesitas crear 3 cuentas gratuitas: **Google/Firebase**, **GitHub** y **Vercel**. Tiempo estimado: 45–60 min.

> Importante: este código está probado con una simulación de Firebase, no contra un Firebase real. Es posible que haya que ajustar algún detalle en la primera puesta en marcha; si algo falla, copia el mensaje de error y se corrige.

## 1. Crear el proyecto en Firebase
1. Entra en https://console.firebase.google.com con una cuenta de Google (mejor la del centro).
2. **Crear proyecto** → nombre `sustituciones-celaya` → desactiva Google Analytics → Crear.

## 2. Activar acceso y base de datos
1. **Compilación → Authentication → Comenzar**. En *Método de acceso* activa **Correo electrónico/contraseña** y, dentro, marca **Vínculo del correo (acceso sin contraseña)**. Activa también **Google** (opcional).
2. **Compilación → Firestore Database → Crear base de datos**. Ubicación: **eur3 (Europa)**. Modo **producción**.
3. Pestaña **Reglas** → borra lo que haya y pega el contenido de `firestore.rules` → **Publicar**.

## 3. Datos de la web (firebase-config.js)
1. ⚙ **Configuración del proyecto → General → Tus apps → icono `</>` (Web)** → nombre `web` → Registrar (sin Hosting).
2. Copia los valores de `firebaseConfig` y pégalos en `public/firebase-config.js` (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId). No son secretos.

## 4. Clave para notificaciones (VAPID)
⚙ **Configuración → Cloud Messaging → Certificados push web → Generar par de claves**. Copia la clave larga y pégala en `FIREBASE_VAPID_KEY` en `public/firebase-config.js`.

## 5. Clave del servidor (solo para enviar notificaciones y cargar datos)
⚙ **Configuración → Cuentas de servicio → Generar nueva clave privada**. Se descarga un `.json`. **Es secreta**: no la subas a GitHub ni la compartas. Guárdala como `clave.json` en esta carpeta (el `.gitignore` la excluye).

## 6. Cargar datos iniciales y tu acceso de jefatura
En un ordenador con Node.js 18+ (https://nodejs.org), dentro de esta carpeta:
```
npm install
node seed.js clave.json tu_correo@dominio.es
```
Carga profesorado, horarios, patios (sept–dic) y te autoriza como **jefatura** con ese correo.

## 7. Subir a GitHub
1. Crea cuenta en https://github.com → **New repository** → `sustituciones-celaya` → **Privado**.
2. Sube el contenido de esta carpeta (botón *uploading an existing file*, o con git). **No subas `clave.json`.**

## 8. Publicar en Vercel
1. https://vercel.com → *Sign up* con GitHub → **Add New → Project** → importa el repositorio.
2. Framework: *Other*. **Output Directory: `public`**. Build command: vacío.
3. **Environment Variables**: nombre `FIREBASE_SERVICE_ACCOUNT`, valor = **todo el contenido** del archivo `clave.json`.
4. **Deploy**. Obtendrás una dirección tipo `sustituciones-celaya.vercel.app`.

## 9. Autorizar el dominio
Firebase → Authentication → **Configuración → Dominios autorizados → Añadir** tu dirección de Vercel (sin https://).

## 10. Probar
1. Abre tu dirección, escribe tu correo → te llega un enlace → ábrelo en el mismo móvil/navegador.
2. En **Centro → Quién puede entrar** pega los correos del profesorado (uno por línea; añade `, jefatura` para dar permisos de edición).
3. Cada profesor/a entra con su correo, elige su nombre y en **Mis sustituciones** pulsa **Activar avisos**.

## Instalar en el móvil
- **Android (Chrome):** menú ⋮ → *Instalar aplicación* / *Añadir a pantalla de inicio*. Las notificaciones funcionan también sin instalar.
- **iPhone (Safari, iOS 16.4 o superior):** botón Compartir → **Añadir a pantalla de inicio**, abrirla desde ese icono y entonces activar avisos. Sin este paso, iOS no permite notificaciones.
- Puedes reutilizar el cartel con el QR apuntando a tu nueva dirección.

## Si el correo con el enlace no llega
Los enlaces de Firebase a veces caen en *spam*. Pídeles que lo busquen ahí, o que usen **Entrar con Google** si tienen cuenta Google.

## Protección de datos (RGPD)
La app guarda nombres, horarios y ausencias de personal. Firestore está en Europa y solo entran correos autorizados. Los motivos de huelga son visibles solo para la jefatura. Aun así, comunica el uso a la dirección/DPD del centro y a la Consejería si lo exige su protocolo. Para borrar todo: **Centro → Borrar datos**.

## Mantenimiento
- Dar de baja a alguien: **Centro → Quién puede entrar → ×**.
- Cambiar código: edita en GitHub y Vercel republica solo.
- Coste: planes gratuitos (Firebase Spark, Vercel Hobby) bastan para un centro de este tamaño.
