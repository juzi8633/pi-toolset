def callee():
    return 1


def target():
    return callee()


def caller():
    return target()
