#pragma once
#include <cstdint>
#include "Sim.h"
inline int esp_sleep_enable_timer_wakeup(uint64_t us) { sim.sleepUs = us; return 0; }
inline void esp_deep_sleep_start() { sim.slept = true; }
