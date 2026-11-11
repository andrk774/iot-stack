#pragma once
#include <cstdint>
enum rst_reason {
  REASON_DEFAULT_RST = 0, REASON_WDT_RST = 1, REASON_EXCEPTION_RST = 2, REASON_SOFT_WDT_RST = 3,
  REASON_SOFT_RESTART = 4, REASON_DEEP_SLEEP_AWAKE = 5, REASON_EXT_SYS_RST = 6
};
struct rst_info { uint32_t reason; uint32_t exccause, epc1, epc2, epc3, excvaddr, depc; };
