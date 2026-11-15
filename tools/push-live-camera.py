"""把本机摄像头实时推送到检测台：python tools/push-live-camera.py --camera 0"""
import argparse, base64, json, time, urllib.request
import cv2

ap = argparse.ArgumentParser()
ap.add_argument('--camera', default='0', help='摄像头序号或 RTSP 地址')
ap.add_argument('--url', default='http://127.0.0.1:8787/api/live/frame')
ap.add_argument('--stream-id', default='default')
ap.add_argument('--fps', type=float, default=2.0, help='推送帧率；检测建议 1~3 FPS')
args = ap.parse_args()
source = int(args.camera) if str(args.camera).isdigit() else args.camera
cap = cv2.VideoCapture(source)
if not cap.isOpened(): raise SystemExit('无法打开视频源: ' + str(source))
print('正在推送到', args.url, '；Ctrl+C 停止')
try:
    while True:
        ok, frame = cap.read()
        if not ok: time.sleep(.2); continue
        ok, jpg = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
        if not ok: continue
        payload = json.dumps({'streamId': args.stream_id, 'device': str(source),
          'image': {'dataUrl': 'data:image/jpeg;base64,' + base64.b64encode(jpg).decode()}},
          ensure_ascii=False).encode()
        req = urllib.request.Request(args.url, data=payload, headers={'Content-Type': 'text/plain'}, method='POST')
        with urllib.request.urlopen(req, timeout=10) as res: print('\rseq ' + str(json.load(res)['seq']), end='', flush=True)
        time.sleep(max(0.01, 1 / args.fps))
finally:
    cap.release()
