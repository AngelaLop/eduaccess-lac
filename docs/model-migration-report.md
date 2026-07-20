# Reporte: deprecación de modelos Groq y plan de migración del chatbot

> Fecha: 19 jul 2026. Escrito como insumo de decisión para v4/v5.
> Estado: **urgente — los modelos actuales se apagan el 16 de agosto de 2026.**

## 1. Qué falla

Groq anunció el **17 de junio de 2026** la deprecación de los dos modelos de los
que depende toda la plataforma, con apagado (requests fallando con error) el
**16 de agosto de 2026** para cuentas free/developer tier:

| Modelo | Dónde se usa | Reemplazo oficial de Groq |
|---|---|---|
| `llama-3.1-8b-instant` | Guard/clasificador del Ask (`apps/web/app/api/ask/route.ts:36`) | `openai/gpt-oss-20b` |
| `llama-3.3-70b-versatile` | Síntesis SQL del Ask (`route.ts:37`) **y** narrativa del worker (`apps/worker/src/llm.ts:14`) | `openai/gpt-oss-120b` |

Impacto si no hacemos nada: el 16 de agosto el chat entero deja de responder
(el guard es la primera llamada de cada request) y el worker no puede generar
briefs de auditoría ni narrativas del Recommender. La UI de mapa e indicadores
sigue viva porque no depende del LLM.

Dos atenuantes de diseño que ya teníamos bien:

- Los IDs de modelo son **env vars** (`GROQ_GUARD_MODEL`, `GROQ_MODEL`) con el
  modelo viejo solo como default hardcodeado. La migración es principalmente
  configuración, no refactor.
- La seguridad del Ask **no depende del modelo** (validador SQL + rate limiter
  + vista constreñida), así que cambiar de modelo no reabre la superficie de
  ataque auditada en v3.

Contexto que cambia la estrategia: Groq también depreció **Kimi K2**
(`moonshotai/kimi-k2-instruct-0905`) en marzo de 2026, siete meses después de
lanzarlo. El catálogo de Groq rota rápido; hay que asumir churn anual de
modelos y diseñar para migrar barato (ver mejora #3).

## 2. Cómo arreglarlo (fix mínimo, ~medio día)

1. En Vercel: `GROQ_GUARD_MODEL=openai/gpt-oss-20b`,
   `GROQ_MODEL=openai/gpt-oss-120b`. En Railway: `GROQ_MODEL=openai/gpt-oss-120b`.
2. Actualizar los defaults hardcodeados en `route.ts:36-37` y `llm.ts:14` para
   que el fallback no sea un modelo muerto.
3. Validar los prompts: gpt-oss son modelos de razonamiento (emiten tokens de
   reasoning antes de la respuesta). Verificar que el JSON de salida del guard
   y del sintetizador SQL sigue parseando; si no, fijar
   `reasoning_effort: 'low'` en el guard (latencia) y revisar `max_tokens`.
4. Bump de `PROMPT_VERSION` en `apps/worker/src/country-brief.ts` para
   invalidar las narrativas cacheadas y regenerarlas con el modelo nuevo.

Ambos reemplazos son **producción** en Groq (no preview), 131k de contexto,
gratis en el free tier actual, y más rápidos que los Llama que reemplazan
(20b: ~1000 tok/s; 120b: ~500 tok/s).

## 3. Opciones evaluadas

**a) Quedarse en Groq → gpt-oss-20b / gpt-oss-120b (recomendada).**
Cero costo, cero cambio de SDK (mismo endpoint OpenAI-compatible), es la ruta
de migración oficial, y gpt-oss-120b razona mejor que llama-3.3-70b para
SQL con esquema constreñido. Tradeoff: seguimos expuestos al churn de Groq y
a sus rate limits de free tier (límites por organización, ~30 req/min).

**b) Kimi K2 vía API directa de Moonshot.**
Calidad fuerte en tareas agénticas y multilingües (relevante si viene el
locale español), API OpenAI-compatible. Tradeoffs: **no tiene free tier**
(mínimo $1 de activación; ~$0.60–1.00/M input, $3–4/M output según variante),
y en Groq ya no existe — sería un proveedor nuevo que pagar y monitorear.
Rompe la regla de "no new model, no cost" de v4. Descartada como primario;
candidata si algún día el narrative tier necesita más calidad.

**c) Ollama Cloud (free tier).**
API OpenAI-compatible, sirve exactamente los mismos `gpt-oss-20b/120b`, free
tier sin tarjeta. Tradeoffs: la cuota es por **tiempo de GPU** con límites por
sesión (reset cada 5 h) y semanales — impredecible para un demo day como
primario. Valor real: **proveedor de fallback** con los mismos modelos y
**desarrollo local gratis e ilimitado** (`ollama run gpt-oss:20b` en laptop)
sin gastar cuota de Groq mientras iteramos prompts.

**d) Consolidar en un solo modelo (gpt-oss-20b para todo).**
Si el eval (paso 1 abajo) muestra que 20b genera SQL correcto para nuestro
esquema de una sola vista, desaparece la arquitectura de dos tiers y su
complejidad, y la cuota rinde el doble. Tradeoff: probable pérdida de calidad
en preguntas de equidad multi-tabla; decidir con datos del eval, no por
intuición.

## 4. Mejoras aprovechando la migración

1. **Set de evaluación dorado** (`scripts/eval-ask.ts`): 15–20 preguntas
   reales con el SQL esperado y el veredicto del guard esperado. Corre contra
   cualquier modelo por env var. Es lo que convierte "creo que funciona" en
   evidencia, y es reutilizable en cada churn futuro de Groq.
2. **`response_format: { type: 'json_object' }`** en guard y sintetizador si
   el modelo lo soporta en Groq — elimina la clase entera de errores de
   parseo que hoy manejamos con retry (`route.ts:803`).
3. **Cadena de fallback de proveedor**: `LLM_BASE_URL`/`LLM_API_KEY`
   secundarios (Ollama Cloud) que el cliente intenta si Groq devuelve 429/5xx
   o error de modelo deprecado. Con ambos proveedores sirviendo gpt-oss, los
   prompts no cambian entre proveedores. ~2–3 h.
4. **`reasoning_effort: 'low'` en el guard** — el clasificador no necesita
   razonamiento profundo y la latencia del stage 1 la paga cada request.

## 5. Pasos de implementación

| # | Paso | Esfuerzo | Cuándo |
|---|---|---|---|
| 1 | Eval set dorado (`scripts/eval-ask.ts`) | 1–2 h | esta semana |
| 2 | Cambiar env vars en preview/local y correr eval con gpt-oss-20b/120b | 1 h | esta semana |
| 3 | Ajustes de prompt si algo falla (JSON estricto, few-shots, reasoning_effort) | 1–2 h | esta semana |
| 4 | Actualizar defaults en código + bump `PROMPT_VERSION` + redeploy web y worker | 30 min | al pasar el eval |
| 5 | Regenerar briefs/narrativas cacheadas y smoke test en producción | 30 min | al pasar el eval |
| 6 | Fallback Ollama Cloud + Ollama local para dev | 2–3 h | opcional, antes de demo day |
| 7 | Decidir consolidación en 20b único con los datos del eval | decisión | después de 1–5 |

Fecha límite dura: **16 de agosto de 2026**. Recomendación: pasos 1–5 esta
semana para no migrar con presión.

## Fuentes

- [Groq — Model Deprecations](https://console.groq.com/docs/deprecations)
- [Groq — Supported Models](https://console.groq.com/docs/models)
- [Groq — Kimi K2-0905 en GroqCloud (lanzamiento)](https://groq.com/blog/introducing-kimi-k2-0905-on-groqcloud) y [su deprecación (comunidad)](https://community.groq.com/t/deprecation-of-kimi-k2-0905-1t-256k/1270)
- [Ollama — Pricing](https://ollama.com/pricing) y [modelos cloud](https://ollama.com/search?c=cloud)
- [Kimi K2 API pricing (análisis de terceros)](https://tokenmix.ai/blog/kimi-k2-api-pricing-tiers-2026)
