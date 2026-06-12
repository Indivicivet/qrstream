# qrstream

Stream data optically (via QR code) -- screen to camera. Opposite camera <-> screen direction required if frames are dropped (to request missing frames).

[indivicivet.github.io/qrstream](https://indivicivet.github.io/qrstream)

Sender flashes a QR code with metadata, then QR codes containing binary data.

If any frames are missed, the receiver displays a QR code to request specific dropped frames. The sender scans this card and loops only the missing frames.
