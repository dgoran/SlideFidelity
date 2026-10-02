#!/usr/bin/env python3
"""
List every font family PowerPoint for Mac can use on this computer, one per line.

Covers fonts registered with macOS (system and user-installed) plus the fonts Microsoft Office
ships inside PowerPoint and its downloaded cloud fonts, which macOS does not register for other
apps. Import the output into SlideCheck: Settings > Show-machine fonts > Import.

Usage: python3 tools/list-fonts-mac.py > show-machine-fonts.txt
"""
import ctypes
import ctypes.util
import os
import sys

ct = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreText"))
cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
cf.CFArrayGetCount.restype = ctypes.c_long
cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
cf.CFStringGetCString.restype = ctypes.c_bool
cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
cf.CFURLCreateFromFileSystemRepresentation.restype = ctypes.c_void_p
cf.CFURLCreateFromFileSystemRepresentation.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_bool]
ct.CTFontManagerCopyAvailableFontFamilyNames.restype = ctypes.c_void_p
ct.CTFontManagerCreateFontDescriptorsFromURL.restype = ctypes.c_void_p
ct.CTFontManagerCreateFontDescriptorsFromURL.argtypes = [ctypes.c_void_p]
ct.CTFontDescriptorCopyAttribute.restype = ctypes.c_void_p
ct.CTFontDescriptorCopyAttribute.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
FAMILY = ctypes.c_void_p.in_dll(ct, "kCTFontFamilyNameAttribute")
UTF8 = 0x08000100

OFFICE_FONT_DIRS = [
    "/Applications/Microsoft PowerPoint.app/Contents/Resources/DFonts",
    os.path.expanduser("~/Library/Group Containers/UBF8T346G9.Office/FontCache"),
]


def cfstring(ref, buf=ctypes.create_string_buffer(1024)):
    return buf.value.decode() if ref and cf.CFStringGetCString(ref, buf, 1024, UTF8) else None


def system_families():
    arr = ct.CTFontManagerCopyAvailableFontFamilyNames()
    return {cfstring(cf.CFArrayGetValueAtIndex(arr, i)) for i in range(cf.CFArrayGetCount(arr))}


def office_families():
    names = set()
    for root in OFFICE_FONT_DIRS:
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                path = os.path.join(dirpath, name).encode()
                url = cf.CFURLCreateFromFileSystemRepresentation(None, path, len(path), False)
                descriptors = ct.CTFontManagerCreateFontDescriptorsFromURL(url) if url else None
                if not descriptors:
                    continue
                for i in range(cf.CFArrayGetCount(descriptors)):
                    desc = cf.CFArrayGetValueAtIndex(descriptors, i)
                    names.add(cfstring(ct.CTFontDescriptorCopyAttribute(desc, FAMILY)))
    return names


def main():
    names = {n for n in system_families() | office_families() if n and not n.startswith(".")}
    sys.stdout.write("\n".join(sorted(names, key=str.casefold)) + "\n")


if __name__ == "__main__":
    main()
