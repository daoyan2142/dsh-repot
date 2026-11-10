"""Generate assets/icon.png — a pot with an upward arrow (换盆)."""
from PIL import Image, ImageDraw

S = 512
BLUE = (76, 141, 255, 255)
WHITE = (255, 255, 255, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded tile
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=112, fill=BLUE)

W = 24  # stroke width

# pot rim
d.rounded_rectangle([112, 312, 400, 356], radius=22, outline=WHITE, width=W)
# pot body: two sloped sides plus a bottom
d.line([(148, 356), (176, 440)], fill=WHITE, width=W)
d.line([(364, 356), (336, 440)], fill=WHITE, width=W)
d.line([(190, 440), (322, 440)], fill=WHITE, width=W)

# arrow shaft rising out of the pot
d.line([(256, 300), (256, 128)], fill=WHITE, width=W)
# arrow head
d.line([(188, 196), (256, 126)], fill=WHITE, width=W)
d.line([(324, 196), (256, 126)], fill=WHITE, width=W)

img.save("assets/icon.png")
img.resize((96, 96), Image.LANCZOS).save("assets/icon-96.png")
print("wrote assets/icon.png and assets/icon-96.png")
