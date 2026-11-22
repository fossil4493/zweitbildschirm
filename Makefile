# Tablet-Zweitbildschirm
#
#   make                    Erweiterung als ZIP bauen (build/)
#   make install-extension  Erweiterung für den aktuellen Benutzer installieren (ohne root)
#   sudo make install       optionalen Firewall-Helfer systemweit installieren
#   sudo make uninstall     Firewall-Helfer entfernen

UUID       := zweitbildschirm@fossil4493.github.io
EXT_SRC    := extension/$(UUID)
BUILD      := build
ZIP        := $(BUILD)/$(UUID).shell-extension.zip

PREFIX     ?= /usr/local
LIBEXECDIR ?= $(PREFIX)/libexec
POLKITDIR  ?= /usr/share/polkit-1/actions
DESTDIR    ?=

EXT_FILES  := $(shell find $(EXT_SRC) -type f ! -name gschemas.compiled)

.PHONY: all zip install-extension uninstall-extension install uninstall clean

all: zip

zip: $(ZIP)

$(ZIP): $(EXT_FILES)
	rm -rf $(BUILD)/stage && mkdir -p $(BUILD)/stage
	cp -r $(EXT_SRC)/. $(BUILD)/stage/
	glib-compile-schemas --strict $(BUILD)/stage/schemas
	rm -f $(ZIP) && cd $(BUILD)/stage && python3 -m zipfile -c ../$(UUID).shell-extension.zip *

install-extension: $(ZIP)
	gnome-extensions install --force $(ZIP)
	@echo "Installiert. Unter Wayland nach dem nächsten Anmelden aktiv;"
	@echo "einschalten mit: gnome-extensions enable $(UUID)"

uninstall-extension:
	gnome-extensions uninstall $(UUID)

install:
	install -d $(DESTDIR)$(LIBEXECDIR) $(DESTDIR)$(POLKITDIR)
	install -m 0755 system/zweitbildschirm-firewall $(DESTDIR)$(LIBEXECDIR)/zweitbildschirm-firewall
	install -m 0755 system/zweitbildschirm-freigabe $(DESTDIR)$(LIBEXECDIR)/zweitbildschirm-freigabe
	sed 's|@LIBEXECDIR@|$(LIBEXECDIR)|g' system/io.github.fossil4493.zweitbildschirm.policy.in \
		> $(DESTDIR)$(POLKITDIR)/io.github.fossil4493.zweitbildschirm.policy
	chmod 0644 $(DESTDIR)$(POLKITDIR)/io.github.fossil4493.zweitbildschirm.policy

uninstall:
	-$(LIBEXECDIR)/zweitbildschirm-firewall close
	rm -f $(DESTDIR)$(LIBEXECDIR)/zweitbildschirm-firewall $(DESTDIR)$(LIBEXECDIR)/zweitbildschirm-freigabe
	rm -f $(DESTDIR)$(POLKITDIR)/io.github.fossil4493.zweitbildschirm.policy
	@echo "Freigegebene Geräte bleiben in /etc/zweitbildschirm/erlaubte-macs (bei Bedarf löschen)."

clean:
	rm -rf $(BUILD)
