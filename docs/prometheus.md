# Integración con Prometheus

## Cambios en el código fuente
- Se añade `prom-client` y un módulo `src/metrics/prometheus.js` que:
  - Registra métricas estándar del proceso (`collectDefaultMetrics`) con prefijo `system_monitor_`.
  - Define `Gauge` para CPU (`cpu_load1`, `cpu_load5`, `cpu_load15`), memoria (`mem_*`), disco (`disk_*`), red (`net_*`) y Transmission (`tx_*`).
  - Expone la ruta `GET /metrics` en `src/app.js` devolviendo el registro en formato Prometheus.
- `src/metrics/recorder.js` acepta `onSample` y publica el último muestreo hacia Prometheus sin duplicar carga de trabajo.

## Endpoints de métricas
- `GET /metrics`: texto plano en formato Prometheus con el prefijo `system_monitor_`.
- `GET /api/stats`: JSON de estado general (sin cambios).

## Frecuencia de muestreo
- La frecuencia de recogida y publicación es `METRICS_INTERVAL_MS` (por defecto 10s). Se usa el mismo intervalo tanto para persistencia en SQLite como para actualizar los `Gauge` de Prometheus.

## Configuración del servidor Prometheus
1. Añadir un job de scraping en `prometheus.yml`:
   ```
   scrape_configs:
     - job_name: 'system-monitor'
       scrape_interval: 15s
       scrape_timeout: 10s
       metrics_path: /metrics
       static_configs:
         - targets: ['HOST_O_IP_DEL_MONITOR:3000']
   ```
   - Reemplace `HOST_O_IP_DEL_MONITOR:3000` por la IP/puerto donde corre la app.
   - El servidor Prometheus corre en `http://192.168.0.25:9090`. Ese endpoint es para consulta; Prometheus no recibe “push” directo en `/query`. Debe “scrapear” la app en `/metrics`.
2. Recarga Prometheus:
   - `systemctl reload prometheus` o reinicio según despliegue.

## Requisitos de seguridad y autenticación
- Prometheus no incluye autenticación nativa en scraping. Recomendaciones:
  - Restrinja el acceso a `/metrics` mediante firewall (solo IPs de Prometheus).
  - Opcional: ponga la app detrás de Nginx/Caddy con Basic Auth/TLS y configure `metrics_path` y `authorization` si usa autenticación.
  - Evite exponer `/metrics` en internet; úselo solo en red privada.

## Estructura de métricas
- Prefijo: `system_monitor_`
- Principales métricas:
  - `system_monitor_cpu_load1`, `system_monitor_cpu_load5`, `system_monitor_cpu_load15`
  - `system_monitor_mem_total_mb`, `system_monitor_mem_used_mb`, `system_monitor_mem_free_mb`, `system_monitor_mem_available_mb`, `system_monitor_mem_used_pct`
  - `system_monitor_swap_total_mb`, `system_monitor_swap_used_mb`
  - `system_monitor_disk_used_pct`, `system_monitor_disk_size_bytes`
  - `system_monitor_net_rx_bps`, `system_monitor_net_tx_bps`
  - `system_monitor_tx_active_torrents`, `system_monitor_tx_download_bps`, `system_monitor_tx_upload_bps`
  - Métricas por defecto del proceso (`nodejs_...`, `system_monitor_process_...` según versión de `prom-client`)

## Dashboard y alertas en Prometheus
- Paneles:
  - Prometheus incluye “Expression browser” y “Consoles” (plantillas). Para paneles ricos se recomienda Grafana, pero puede usar Consoles:
    - Copie una consola personalizada en el directorio `consoles/` de Prometheus y apunte `web.console.libraries` y `web.console.templates`.
    - Ejemplos de expresiones:
      - `system_monitor_mem_used_pct`
      - `rate(system_monitor_net_rx_bps[5m])`
      - `system_monitor_cpu_load1`
- Alertas (reglas):
  - Añada en `rule_files`:
    ```
    groups:
      - name: system-monitor-alerts
        rules:
          - alert: MemoriaAlta
            expr: system_monitor_mem_used_pct >= 80
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: Uso de memoria alto
          - alert: MemoriaCritica
            expr: system_monitor_mem_used_pct >= 90
            for: 2m
            labels:
              severity: critical
            annotations:
              summary: Uso de memoria crítico
          - alert: DiscoCritico
            expr: system_monitor_disk_used_pct >= 90
            for: 5m
            labels:
              severity: critical
            annotations:
              summary: Uso de disco crítico
    ```
  - Configure Alertmanager para envío de notificaciones (email, Slack, etc.).

## Intervalos de actualización recomendados
- `scrape_interval: 15s` y `METRICS_INTERVAL_MS: 10000` ofrecen datos actuales con bajo impacto.
- Aumente a `30s` en hardware limitado.

## Pruebas de carga
- Use el script `scripts/load-test.js` para medir impacto sobre `/metrics` y `/api/stats`.
- Objetivo: latencia media < 100ms bajo 50 req/s en red local, y CPU estable sin picos sostenidos.

## Mantenimiento del dashboard
- Documente los paneles usados y queries en un repositorio interno.
- Revise umbrales trimestralmente según comportamiento real.
- Audite accesos y rotación de credenciales si usa proxy con auth.

