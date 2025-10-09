import base64

data = ""
with open("record_base64.txt", "r", encoding="utf-8") as f:
    for line in f:
        if line.strip().startswith("==="): 
            continue
        data += line.strip()

with open("record.wav", "wb") as f:
    f.write(base64.b64decode(data))

print("✅ record.wav saved!")
