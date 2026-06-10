@echo off
echo Installing PyInstaller...
pip install pyinstaller

echo Building Lyrics Notepad EXE...
python -m PyInstaller --noconfirm --onefile --windowed --add-data "web;web" --name "LyricsNotepad" main.py

echo Build Complete! Check the 'dist' folder for LyricsNotepad.exe
pause
