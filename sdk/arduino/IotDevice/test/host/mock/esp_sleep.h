#pragma once
#include <cstdint>
inline int esp_sleep_enable_timer_wakeup(uint64_t us) { (void)us; return 0; }
inline void esp_deep_sleep_start() {}
