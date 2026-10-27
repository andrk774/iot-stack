# Проверки SDK на ПК (без платы):
#   make test     — юнит-тесты протокола
#   make compile  — компиляция SDK и примеров с заглушками Arduino + настоящим PubSubClient
#   make          — всё сразу
CXX      ?= g++
CXXFLAGS ?= -std=gnu++17 -Wall -Wextra -Werror -Wno-unused-parameter
SRC      := ../../src
PUBSUB   ?= build/pubsubclient
BUILD    := build

.PHONY: all test device compile compile8266 clean
all: test device compile compile8266

test: $(BUILD)/protocol_test
	./$(BUILD)/protocol_test

$(BUILD)/protocol_test: protocol_test.cpp $(SRC)/IotProtocol.cpp $(SRC)/IotProtocol.h
	@mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) -I$(SRC) protocol_test.cpp $(SRC)/IotProtocol.cpp -o $@

$(PUBSUB)/src/PubSubClient.cpp:
	git clone --depth 1 https://github.com/knolleary/pubsubclient.git $(PUBSUB)

EXAMPLES := Basic Portal Thermostat

# ---------- поведение: SDK + настоящий PubSubClient против симулятора (sim/) ----------
$(BUILD)/pubsub-sim.o: $(PUBSUB)/src/PubSubClient.cpp
	@mkdir -p $(BUILD)
	$(CXX) -std=gnu++17 -w -DESP32 -Isim -I$(PUBSUB)/src -c $< -o $@

device: $(BUILD)/pubsub-sim.o
	$(CXX) $(CXXFLAGS) -DESP32 -Isim -I$(SRC) -I$(PUBSUB)/src device_test.cpp \
	  $(SRC)/IotDevice.cpp $(SRC)/IotPortal.cpp $(SRC)/IotProtocol.cpp $(SRC)/IotStorage.cpp \
	  $(BUILD)/pubsub-sim.o sim/sim.cpp -o $(BUILD)/device_test
	./$(BUILD)/device_test

# сторонняя библиотека — без -Werror
$(BUILD)/pubsub.o: $(PUBSUB)/src/PubSubClient.cpp
	@mkdir -p $(BUILD)
	$(CXX) -std=gnu++17 -w -DESP32 -Imock -I$(PUBSUB)/src -c $< -o $@

compile: $(BUILD)/pubsub.o
	@mkdir -p $(BUILD)
	@for ex in $(EXAMPLES); do \
	  printf '#include <Arduino.h>\n#include "../../../examples/%s/%s.ino"\nint main(){setup();loop();return 0;}\n' $$ex $$ex > $(BUILD)/$$ex.cpp; \
	  echo "compile example $$ex"; \
	  $(CXX) $(CXXFLAGS) -DESP32 -Imock -I$(SRC) -I$(PUBSUB)/src -c $(BUILD)/$$ex.cpp -o $(BUILD)/$$ex.o || exit 1; \
	  $(CXX) $(CXXFLAGS) -DESP32 -Imock -I$(SRC) -I$(PUBSUB)/src $(BUILD)/$$ex.o \
	    $(SRC)/IotDevice.cpp $(SRC)/IotPortal.cpp $(SRC)/IotProtocol.cpp $(SRC)/IotStorage.cpp \
	    $(BUILD)/pubsub.o mock/mock.cpp -o $(BUILD)/$$ex || exit 1; \
	  ./$(BUILD)/$$ex >/dev/null || exit 1; \
	done
	@echo "all examples compiled and linked"

# ---------- ESP8266: свои заглушки (BearSSL, LittleFS, ESP8266WebServer) ----------
$(BUILD)/pubsub8266.o: $(PUBSUB)/src/PubSubClient.cpp
	@mkdir -p $(BUILD)
	$(CXX) -std=gnu++17 -w -DESP8266 -Imock8266 -I$(PUBSUB)/src -c $< -o $@

compile8266: $(BUILD)/pubsub8266.o
	@mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) -DESP8266 -Imock8266 -I$(SRC) storage_test.cpp $(SRC)/IotStorage.cpp $(SRC)/IotProtocol.cpp mock8266/mock.cpp -o $(BUILD)/storage8266
	./$(BUILD)/storage8266
	@for ex in $(EXAMPLES); do \
	  printf '#include <Arduino.h>\n#include "../../../examples/%s/%s.ino"\nint main(){setup();loop();return 0;}\n' $$ex $$ex > $(BUILD)/$$ex-8266.cpp; \
	  echo "compile example $$ex (ESP8266)"; \
	  $(CXX) $(CXXFLAGS) -DESP8266 -Imock8266 -I$(SRC) -I$(PUBSUB)/src $(BUILD)/$$ex-8266.cpp \
	    $(SRC)/IotDevice.cpp $(SRC)/IotPortal.cpp $(SRC)/IotProtocol.cpp $(SRC)/IotStorage.cpp \
	    $(BUILD)/pubsub8266.o mock8266/mock.cpp -o $(BUILD)/$$ex-8266 || exit 1; \
	  ./$(BUILD)/$$ex-8266 >/dev/null || exit 1; \
	done
	@echo "all examples compiled and linked for ESP8266"

clean:
	rm -rf $(BUILD)
