-- FlightHopper on the living-room TV (2026-09-30). Sunshine streams the headless output FHTV (1080p: the TV's Wi-Fi carries ~9 Mbit/s) to Moonlight on the TV;
-- ~/.local/bin/fh-tv-start (Sunshine's prep command) creates FHTV and opens the kiosk on it, fh-tv-stop removes both.
-- At 0x3000 it touches no other screen, so the pointer never wanders onto the TV picture.
hl.monitor({ output = "FHTV", mode = "1920x1080@60", position = "0x3000", scale = 1 })
o.window("^flighthopper-tv$", { monitor = "FHTV", fullscreen = true, idle_inhibit = "always", tag = "-default-opacity", opacity = "1.0 1.0" })
