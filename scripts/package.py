"""Package only the loadable extension, with manifest.json at the ZIP root."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
destination = root / "dist" / "retrospection-1.0.0.zip"
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
    for source in sorted((root / "extension").rglob("*")):
        if source.is_file():
            archive.write(source, source.relative_to(root / "extension"))
print(destination)
