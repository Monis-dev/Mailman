# 1. Hardware & Environment:
- OS (e.g. Windows 11 with Docker Desktop / WSL2)
- Runtime: Node.js v22, Redis 7 Alpine, PostgreSQL 16 Alpine
# 2. Benchmark Test Results Matrix:
- Baseline (**10 Connections**):
    - Throughput: *~546 Req/Sec*
    - Latency: *Avg 17.8ms | P50 17ms | P99 29ms*
    - Error Rate: *0%*
- Stress Test (**50 Connections**):
    - Throughput: *~737 Req/Sec* (14,743 total jobs ingested in 20s)
    - Latency: *Avg 67.4ms | P50 66ms | P99 94ms*
    - Error Rate: *0%*
- Shield / Rate Limiting Test:
    - Verified clean load shedding: excess bursts rejected with 429 Too Many Requests without crashing database connection pools.