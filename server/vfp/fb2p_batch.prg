#DEFINE CRLF CHR(13) + CHR(10)
#DEFINE TAB CHR(9)
*------------------------------------------------------------------------------
* fb2p_batch.prg - executa uma lista de conversoes com o FoxBin2Prg
*
* Entrada (variaveis de ambiente):
*   FPI_JOB          pasta do job (contem tasks.txt)
*   FPI_FB2P         pasta do runtime do FoxBin2Prg
*
* tasks.txt (uma tarefa por linha, separada por TAB):
*   BIN2PRG<TAB>caminho\arquivo.scx
*   PRG2BIN<TAB>caminho\arquivo.sc2
*
* Saida:
*   fb2p-status.txt  uma linha por tarefa:
*                    indice<TAB>tipo<TAB>ok|fail<TAB>arquivo<TAB>mensagem
*------------------------------------------------------------------------------
SET TALK OFF
SET SAFETY OFF
SET NOTIFY OFF
SET ESCAPE OFF
SET RESOURCE OFF
SET PROCEDURE TO
CLOSE DATABASES ALL

LOCAL cJob, cFb2p, cTasks, cStatus, cErrLog, cErrText
LOCAL lnTasks, lnI, lnPos, lnOk, lnErrNo
LOCAL cLine, cType, cFile, cMsg, cOut
LOCAL ARRAY aTasks[1]
LOCAL loErr

cJob = ADDBS(GETENV("FPI_JOB"))
cFb2p = ADDBS(GETENV("FPI_FB2P"))
cStatus = cJob + "fb2p-status.txt"
cTasks = cJob + "tasks.txt"

IF EMPTY(cJob) OR !DIRECTORY(cJob)
    RETURN
ENDIF

IF EMPTY(cFb2p) OR !FILE(cFb2p + "foxbin2prg.prg")
    STRTOFILE("0" + TAB + "?" + TAB + "fail" + TAB + "" + TAB + "FoxBin2Prg nao instalado" + CRLF, cStatus)
    QUIT
ENDIF

IF !FILE(cTasks)
    STRTOFILE("0" + TAB + "?" + TAB + "fail" + TAB + "" + TAB + "tasks.txt ausente" + CRLF, cStatus)
    QUIT
ENDIF

STRTOFILE("", cStatus)
lnTasks = ALINES(aTasks, FILETOSTR(cTasks))

FOR lnI = 1 TO lnTasks
    cLine = ALLTRIM(aTasks[lnI])
    IF EMPTY(cLine)
        LOOP
    ENDIF

    lnPos = AT(TAB, cLine)
    IF lnPos <= 1
        cType = ""
        cFile = ""
    ELSE
        cType = UPPER(ALLTRIM(LEFT(cLine, lnPos - 1)))
        cFile = ALLTRIM(SUBSTR(cLine, lnPos + 1))
    ENDIF

    lnOk = 0
    cMsg = ""

    DO CASE
    CASE !INLIST(cType, "BIN2PRG", "PRG2BIN")
        cMsg = "Tipo de conversao invalido: " + cType
    CASE EMPTY(cFile) OR !FILE(cFile)
        cMsg = "Arquivo nao encontrado: " + cFile
    OTHERWISE
        cErrLog = cJob + "foxbin2prg_errorlog.ERR"
        TRY
            ERASE (cErrLog)
            ERASE (cFb2p + "foxbin2prg_errorlog.ERR")

            DO (cFb2p + "foxbin2prg.prg") WITH cFile, cType, "", ;
                (cType == "BIN2PRG"), "1", "0", "1", "", "1", "0"

            IF FILE(cErrLog)
                cErrText = FILETOSTR(cErrLog)
                IF !EMPTY(ALLTRIM(cErrText))
                    cMsg = LEFT(STRTRAN(cErrText, CRLF, " "), 500)
                ENDIF
            ENDIF

            IF EMPTY(cMsg) AND FILE(cFb2p + "foxbin2prg_errorlog.ERR")
                cErrText = FILETOSTR(cFb2p + "foxbin2prg_errorlog.ERR")
                IF !EMPTY(ALLTRIM(cErrText))
                    cMsg = LEFT(STRTRAN(cErrText, CRLF, " "), 500)
                ENDIF
            ENDIF

            IF EMPTY(cMsg)
                lnOk = 1
            ENDIF
        CATCH TO loErr
            cMsg = "Erro " + TRANSFORM(loErr.ErrorNo) + ": " + loErr.Message
            lnOk = 0
        ENDTRY
    ENDCASE

    IF EMPTY(cMsg)
        cMsg = IIF(lnOk = 1, "ok", "falha sem detalhes")
    ENDIF

    cMsg = STRTRAN(STRTRAN(STRTRAN(cMsg, CRLF, " "), CHR(10), " "), TAB, " ")
    STRTOFILE(TRANSFORM(lnI) + TAB + cType + TAB + IIF(lnOk = 1, "ok", "fail") + TAB + ;
        cFile + TAB + cMsg + CRLF, cStatus, .T.)
ENDFOR

QUIT
