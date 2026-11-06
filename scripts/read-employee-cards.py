import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile


def read_rows(path):
    namespace = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(path) as archive:
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings = ["".join(item.itertext()) for item in ET.fromstring(
                archive.read("xl/sharedStrings.xml")).findall("s:si", namespace)]
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheet = next((item for item in workbook.findall("s:sheets/s:sheet", namespace)
                      if item.get("name") == "Empleados"), None)
        if sheet is None:
            raise ValueError("El Excel debe contener la hoja Empleados.")
        relationship_id = sheet.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        target = next(item.get("Target") for item in relationships if item.get("Id") == relationship_id)
        sheet_path = target.lstrip("/") if target.startswith("/") else "xl/" + target
        rows = []
        headers = None
        for row in ET.fromstring(archive.read(sheet_path)).findall("s:sheetData/s:row", namespace):
            cells = {}
            for cell in row.findall("s:c", namespace):
                if cell.find("s:f", namespace) is not None:
                    raise ValueError("El archivo debe contener valores, no fórmulas.")
                value = cell.find("s:v", namespace)
                text = value.text if value is not None else ""
                if cell.get("t") == "s":
                    text = strings[int(text)]
                elif cell.get("t") == "inlineStr":
                    text = "".join(cell.find("s:is", namespace).itertext())
                cells[re.sub(r"\d", "", cell.get("r"))] = (text or "").strip()
            if not any(cells.values()):
                continue
            if headers is None:
                headers = cells
                if [headers.get(column) for column in ("A", "B", "C")] != [
                        "NÚMERO DE EMPLEADO", "NOMBRE", "NÚMERO DE TARJETA"]:
                    raise ValueError("Las primeras columnas deben ser número de empleado, nombre y número de tarjeta.")
                continue
            rows.append({"employeeNumber": cells.get("A", ""), "name": cells.get("B", ""),
                         "cardNumber": cells.get("C", ""), "line": int(row.get("r"))})
        if not rows or len(rows) > 10000:
            raise ValueError("El archivo debe contener entre 1 y 10000 empleados.")
        return rows


if __name__ == "__main__":
    print(json.dumps(read_rows(sys.argv[1]), ensure_ascii=False))
